from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid5

import numpy as np
import soundfile as sf
import torch

import earcopy_service.jobs as jobs
from earcopy_service.beat_analysis import BEAT_MODEL_SHA256, correct_note_timing
from earcopy_service.diagnostics import enable_crash_diagnostics
from earcopy_service.instruments import INSTRUMENT_BY_ID
from earcopy_service.models import Note, PITCHED_MIDI_CHANNELS, Track
from scripts.compare_muscriptor_variants import _crop_reference_notes, _reference_notes
from scripts.evaluate_onset_correction import match_notes, score


def sha256(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def make_tracks(case: dict) -> list[Track]:
    channels = iter(PITCHED_MIDI_CHANNELS)
    tracks = []
    for index, name in enumerate(case['fixedInstruments']):
        instrument = INSTRUMENT_BY_ID[name]
        tracks.append(Track(
            id=uuid5(NAMESPACE_URL, case['trackId'] + '/' + name),
            displayName=name, instrumentId=name, kind=instrument.kind,
            color='#4C9AFF', order=index + 1,
            midiChannel=10 if name == 'drums' else next(channels),
            gmProgram=instrument.gm_program,
        ))
    return tracks


def run_job(manager, request, correction_enabled, record_path, identity):
    if record_path.is_file():
        previous = json.loads(record_path.read_text(encoding='utf-8'))
        if previous['identity'] != identity:
            raise ValueError(f'Existing evaluation has different inputs: {record_path}')
        print(f"Reusing completed evaluation: {record_path.name}", flush=True)
        return previous
    corrections = []

    def measure(notes, grid):
        started = time.perf_counter()
        corrected, delay = correct_note_timing(notes, grid) if correction_enabled else (list(notes), 0.0)
        corrections.append({
            'notes': len(notes), 'delayMs': delay * 1000,
            'seconds': time.perf_counter() - started,
        })
        return corrected, delay

    started = time.perf_counter()
    with patch.object(jobs, 'correct_note_timing', measure):
        job_id = manager.start(request)
        cursor = 0
        for packet in manager.iter_sse(job_id):
            # Consume events while the model runs so each input's progress is visible.
            for line in packet.splitlines():
                if not line.startswith('data: '):
                    continue
                event = json.loads(line[6:])
                if event['type'] == 'partial_result':
                    print(json.dumps({
                        'mode': request.mode, 'correction': correction_enabled,
                        'input': event['inputName'], 'notes': event['noteCount'],
                        'correctionMs': event['onsetCorrectionSec'] * 1000,
                        'cacheHit': event['cacheHit'],
                    }), flush=True)
                cursor += 1
        status = manager.wait_for_terminal(job_id)
    events = [packet.data for packet in manager.events(job_id)]
    if status != 'completed':
        raise RuntimeError([event for event in events if event['type'] == 'error'])
    notes = {}
    for event in events:
        if event['type'] == 'note':
            notes[event['id']] = {key: value for key, value in event.items() if key != 'type'}
        elif event['type'] == 'note_cleanup':
            for identifier in event['removedNoteIds']:
                notes.pop(identifier, None)
    record = {
        'identity': identity, 'seconds': time.perf_counter() - started,
        'notes': list(notes.values()), 'corrections': corrections,
        'partials': [event for event in events if event['type'] == 'partial_result'],
        'stems': [event['stem'] for event in events if event['type'] == 'stem'],
    }
    record_path.write_text(json.dumps(record, indent=2), encoding='utf-8')
    return record


def compare_records(before, after, reference):
    before_notes = [Note.model_validate(row) for row in before['notes']]
    after_notes = [Note.model_validate(row) for row in after['notes']]
    after_by_id = {note.id: note for note in after_notes}
    pairs = match_notes(before_notes, reference, 0.12)
    common = [(i, j) for i, j in pairs if before_notes[i].id in after_by_id]
    before_errors = [before_notes[i].start_sec - reference[j].start_sec for i, j in common]
    after_errors = [after_by_id[before_notes[i].id].start_sec - reference[j].start_sec for i, j in common]
    result = {
        'referenceNotes': len(reference),
        'beforeNotes': len(before_notes), 'afterNotes': len(after_notes),
        'commonNoteIds': len({note.id for note in before_notes} & after_by_id.keys()),
        'pairedMatches120Ms': len(common),
        'beforeMaeMs': float(np.mean(np.abs(before_errors))) * 1000 if common else None,
        'afterMaeMs': float(np.mean(np.abs(after_errors))) * 1000 if common else None,
        'before': {str(ms): score(before_notes, reference, ms / 1000) for ms in (20, 50, 120)},
        'after': {str(ms): score(after_notes, reference, ms / 1000) for ms in (20, 50, 120)},
        'coldCorrectedJobSec': after['seconds'],
        'cachedUncorrectedJobSec': before['seconds'],
        'correctionCalculationSec': sum(row['seconds'] for row in after['corrections']),
        'primaryInputs': [{
            'name': row['inputName'], 'notes': row['noteCount'],
            'correctionMs': row['onsetCorrectionSec'] * 1000,
            'invalidChunks': row['invalidChunkCount'],
            'referenceNotes': row['timingGuideUnmodifiedNoteCount'],
            'filterDiscarded': row['timingGuideNoteDiscardedCount'],
            'filterMerged': row['timingGuideNoteMergedCount'],
        } for row in after['partials']],
        'baselinePrimaryCacheHits': [row['cacheHit'] for row in before['partials']],
        'baselineReferenceCacheHits': [row['timingGuideFilterCacheHit'] for row in before['partials']],
        'separatedSources': [{
            'type': row['type'], 'sha256': row['sha256'],
        } for row in after['stems']],
    }
    return result, before_errors, after_errors


def aggregate(rows, before_errors, after_errors):
    summary = {
        'cases': len(rows), 'referenceNotes': sum(row['referenceNotes'] for row in rows),
        'beforeNotes': sum(row['beforeNotes'] for row in rows),
        'afterNotes': sum(row['afterNotes'] for row in rows),
        'pairedMatches120Ms': len(before_errors),
        'beforeMaeMs': float(np.mean(np.abs(before_errors))) * 1000 if before_errors else None,
        'afterMaeMs': float(np.mean(np.abs(after_errors))) * 1000 if after_errors else None,
        'beforeP95AbsoluteErrorMs': float(np.percentile(np.abs(before_errors), 95)) * 1000 if before_errors else None,
        'afterP95AbsoluteErrorMs': float(np.percentile(np.abs(after_errors), 95)) * 1000 if after_errors else None,
        'coldCorrectedJobsSec': sum(row['coldCorrectedJobSec'] for row in rows),
        'cachedUncorrectedJobsSec': sum(row['cachedUncorrectedJobSec'] for row in rows),
        'correctionCalculationSec': sum(row['correctionCalculationSec'] for row in rows),
        'correctedPrimaryInputs': sum(abs(item['correctionMs']) > 1e-6 for row in rows for item in row['primaryInputs']),
        'primaryInputs': sum(len(row['primaryInputs']) for row in rows),
    }
    for mode in ('before', 'after'):
        denominator = summary[mode + 'Notes'] + summary['referenceNotes']
        summary[mode + 'F1'] = {
            str(ms): 2 * sum(row[mode][str(ms)]['matches'] for row in rows) / denominator
            if denominator else 0.0 for ms in (20, 50, 120)
        }
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-root', type=Path, required=True)
    parser.add_argument('--model', type=Path, default=Path('models/muscriptor/medium/model.safetensors'))
    parser.add_argument('--work-dir', type=Path, default=Path('app/benchmark/muscriptor-030/application-onset'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--modes', nargs='+', choices=('direct', 'separated'), default=['direct', 'separated'])
    args = parser.parse_args()
    args.work_dir = args.work_dir.resolve()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    os.environ['EARCOPY_USER_DATA'] = str(args.work_dir / 'UserData')
    os.environ['EARCOPY_STEM_MODEL_DIR'] = str(Path('models/bs-roformer/sw-fixed').resolve())
    enable_crash_diagnostics()
    config = json.loads(Path('scripts/benchmark_cases/babyslakh_v2.json').read_text(encoding='utf-8'))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    identity = {
        'applicationCommit': commit, 'evaluationScriptSha256': sha256(Path(__file__)),
        'modelSha256': sha256(args.model), 'beatModelSha256': BEAT_MODEL_SHA256,
        'separationModelSha256': sha256(Path('models/bs-roformer/sw-fixed/BS-Rofo-SW-Fixed.ckpt')),
        'modelVariant': args.model.parent.name, 'backend': 'CUDA', 'dtype': 'float16',
        'profile': 'high_accuracy', 'instrumentSelection': 'fixed',
        'familyExpansion': True, 'familyDuplicateCollapse': True,
        'drumOnsetGuide': True, 'timingGuideNoteFilter': True,
        'velocityFromStemAmplitude': True,
    }
    report = {
        'conditions': identity, 'dataset': config['dataset'],
        'environment': {'torch': torch.__version__, 'gpu': torch.cuda.get_device_name()},
        'cases': [], 'summary': {},
    }
    errors = {mode: ([], []) for mode in args.modes}
    for case in config['segments']:
        identifier = case['trackId']
        source_dir = args.dataset_root / identifier
        audio_path = args.work_dir / f'{identifier}.wav'
        with sf.SoundFile(source_dir / 'mix.wav') as source:
            source.seek(round(case['startSec'] * source.samplerate))
            audio = source.read(round(case['durationSec'] * source.samplerate), dtype='float32')
            sample_rate = source.samplerate
        sf.write(audio_path, audio, sample_rate, subtype='FLOAT')
        reference = _crop_reference_notes(_reference_notes(source_dir / 'all_src.mid'), case['startSec'], case['durationSec'])
        audio_sha = sha256(audio_path)
        tracks = make_tracks(case)
        for mode in args.modes:
            print(f'Starting {identifier}: {mode}', flush=True)
            request = jobs.TranscriptionJobRequest(
                audioPath=str(audio_path), modelPath=str(args.model.resolve()),
                modelVariant=args.model.parent.name, backend='CUDA', dtype='float16',
                mode=mode, tracks=tracks, transcriptionProfile='high_accuracy',
                drumOnsetGuide=mode == 'separated', timingGuideNoteFilter=mode == 'separated',
                velocityFromStemAmplitude=True,
            )
            manager = jobs.TranscriptionJobManager()
            run_identity = {**identity, 'audioSha256': audio_sha, 'mode': mode}
            after = run_job(manager, request, True,
                args.work_dir / f'{identifier}-{mode}-corrected.json', {**run_identity, 'correction': True})
            before = run_job(manager, request, False,
                args.work_dir / f'{identifier}-{mode}-uncorrected.json', {**run_identity, 'correction': False})
            result, before_errors, after_errors = compare_records(before, after, reference)
            result.update({
                'track': identifier, 'mode': mode, 'audioSha256': audio_sha,
                'referenceMidiSha256': sha256(source_dir / 'all_src.mid'),
                'startSec': case['startSec'], 'durationSec': case['durationSec'],
                'fixedInstruments': case['fixedInstruments'],
            })
            errors[mode][0].extend(before_errors)
            errors[mode][1].extend(after_errors)
            report['cases'].append(result)
            report['summary'][mode] = aggregate([row for row in report['cases'] if row['mode'] == mode], *errors[mode])
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(result), flush=True)
    print(json.dumps(report['summary'], indent=2), flush=True)


if __name__ == '__main__':
    main()
