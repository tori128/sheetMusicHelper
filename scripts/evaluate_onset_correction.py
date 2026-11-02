from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import numpy as np
import soundfile as sf
from scipy.optimize import linear_sum_assignment

from earcopy_service.backends import BackendInvalidChunk, BackendNoteEnd, BackendNoteStart, CudaMuscriptorBackend
from earcopy_service.beat_analysis import analyze_beats, correct_note_timing
from earcopy_service.models import Note
from earcopy_service.note_processing import NoteEventAssembler, NoteEndEvent, NoteStartEvent
from earcopy_service.transcription_postprocessing import postprocess_transcription_notes
from scripts.compare_muscriptor_variants import _crop_reference_notes, _reference_notes


def match_notes(predicted, reference, tolerance):
    groups = defaultdict(lambda: ([], []))
    for index, note in enumerate(predicted):
        groups[(note.source_instrument_id, note.pitch)][0].append(index)
    for index, note in enumerate(reference):
        groups[(note.instrument, note.pitch)][1].append(index)
    matches = []
    for left, right in groups.values():
        if not left or not right:
            continue
        errors = np.asarray([[abs(predicted[i].start_sec - reference[j].start_sec) for j in right] for i in left])
        rows, columns = linear_sum_assignment(np.where(errors <= tolerance, errors, 1e6))
        matches.extend((left[i], right[j]) for i, j in zip(rows, columns) if errors[i, j] <= tolerance)
    return matches


def score(predicted, reference, tolerance):
    matched = len(match_notes(predicted, reference, tolerance))
    return {'matches': matched, 'f1': 2 * matched / (len(predicted) + len(reference)) if predicted or reference else 0.0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-root', type=Path, required=True)
    parser.add_argument('--model', type=Path, default=Path('models/muscriptor/medium/model.safetensors'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--work-dir', type=Path, default=Path('app/benchmark/muscriptor-030/onset'))
    args = parser.parse_args()
    config = json.loads(Path('scripts/benchmark_cases/babyslakh_v2.json').read_text(encoding='utf-8'))
    args.work_dir.mkdir(parents=True, exist_ok=True)
    backend = CudaMuscriptorBackend()
    loaded = False
    results = []
    all_before, all_after = [], []
    try:
        for case in config['segments']:
            identifier = case['trackId']
            track = args.dataset_root / identifier
            audio_path = args.work_dir / f'{identifier}.wav'
            with sf.SoundFile(track / 'mix.wav') as source:
                source.seek(round(case['startSec'] * source.samplerate))
                audio = source.read(round(case['durationSec'] * source.samplerate), dtype='float32')
                sample_rate = source.samplerate
            if not audio_path.is_file():
                sf.write(audio_path, audio, sample_rate, subtype='FLOAT')
            grid = analyze_beats(audio_path)
            reference = _crop_reference_notes(_reference_notes(track / 'all_src.mid'), case['startSec'], case['durationSec'])
            cache = args.work_dir / f'{identifier}-{args.model.parent.name}-raw.json'
            if cache.is_file():
                notes = [Note.model_validate(row) for row in json.loads(cache.read_text(encoding='utf-8'))]
            else:
                if not loaded:
                    backend.load(args.model, 'float16')
                    loaded = True
                instruments = case['fixedInstruments']
                assembler = NoteEventAssembler({name: uuid5(NAMESPACE_URL, name) for name in instruments})
                notes = []
                invalid_chunks = []
                def on_event(event):
                    if isinstance(event, BackendNoteStart):
                        assembler.feed(NoteStartEvent(event_index=event.event_index, instrument_id=event.instrument_id, pitch=event.pitch, start_sec=event.start_sec))
                    elif isinstance(event, BackendNoteEnd):
                        note = assembler.feed(NoteEndEvent(event_index=event.event_index, end_sec=event.end_sec))
                        if note is not None:
                            notes.append(note)
                    elif isinstance(event, BackendInvalidChunk):
                        invalid_chunks.append(event)
                backend.transcribe(audio_path, instruments, on_event)
                notes = postprocess_transcription_notes(notes, invalid_chunks, {name: audio_path for name in instruments}, {}, {}, missing_sustain_chunk_duration_sec=None).notes
                cache.write_text(json.dumps([note.model_dump(by_alias=True, mode='json') for note in notes]), encoding='utf-8')
            corrected, delay = correct_note_timing(notes, grid)
            pairs = match_notes(notes, reference, 0.12)
            before_errors = [notes[i].start_sec - reference[j].start_sec for i, j in pairs]
            after_errors = [corrected[i].start_sec - reference[j].start_sec for i, j in pairs]
            all_before.extend(before_errors)
            all_after.extend(after_errors)
            result = {
                'track': identifier, 'startSec': case['startSec'], 'durationSec': case['durationSec'],
                'audioSha256': hashlib.sha256(audio_path.read_bytes()).hexdigest(),
                'referenceMidiSha256': hashlib.sha256((track / 'all_src.mid').read_bytes()).hexdigest(),
                'referenceNotes': len(reference), 'predictedNotes': len(notes),
                'constantTempoDetected': grid is not None, 'onsetCorrectionMs': delay * 1000,
                'pairedMatches120Ms': len(pairs),
                'before': {str(ms): score(notes, reference, ms / 1000) for ms in (20, 50, 120)},
                'after': {str(ms): score(corrected, reference, ms / 1000) for ms in (20, 50, 120)},
                'beforeMaeMs': float(np.mean(np.abs(before_errors))) * 1000 if pairs else None,
                'afterMaeMs': float(np.mean(np.abs(after_errors))) * 1000 if pairs else None,
            }
            results.append(result)
            print(json.dumps(result), flush=True)
    finally:
        backend.unload()
    summary = {
        'cases': len(results), 'correctedCases': sum(abs(row['onsetCorrectionMs']) > 1e-6 for row in results),
        'pairedMatches120Ms': len(all_before),
        'beforeMaeMs': float(np.mean(np.abs(all_before))) * 1000,
        'afterMaeMs': float(np.mean(np.abs(all_after))) * 1000,
        'beforeMedianSignedErrorMs': float(np.median(all_before)) * 1000,
        'afterMedianSignedErrorMs': float(np.median(all_after)) * 1000,
        'beforeP95AbsoluteErrorMs': float(np.percentile(np.abs(all_before), 95)) * 1000,
        'afterP95AbsoluteErrorMs': float(np.percentile(np.abs(all_after), 95)) * 1000,
    }
    denominator = sum(row['referenceNotes'] + row['predictedNotes'] for row in results)
    for mode in ('before', 'after'):
        summary[mode + 'F1'] = {str(ms): 2 * sum(row[mode][str(ms)]['matches'] for row in results) / denominator for ms in (20, 50, 120)}
    report = {'modelVariant': args.model.parent.name, 'backend': 'CUDA', 'dtype': 'float16', 'dataset': config['dataset'], 'summary': summary, 'cases': results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
