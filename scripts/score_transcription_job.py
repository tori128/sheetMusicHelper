from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median

import soundfile

try:
    from scripts.compare_muscriptor_variants import (
        ResultNote,
        _crop_reference_notes,
        _notation_score,
        _reference_notes,
        _reference_score,
    )
except ModuleNotFoundError:
    from compare_muscriptor_variants import (
        ResultNote,
        _crop_reference_notes,
        _notation_score,
        _reference_notes,
        _reference_score,
    )
from earcopy_service.jobs import (
    TranscriptionMethodPolicy,
    TranscriptionJobManager,
    TranscriptionJobRequest,
)
from earcopy_service.audio import prepare_analysis_audio
from earcopy_service.instruments import get_instrument
from earcopy_service.models import PITCHED_MIDI_CHANNELS, Track
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.presets import TRACK_COLOR_PALETTE
from earcopy_service.stem_separation import (
    BASS_DRUM_GUIDE_HIGHPASS_HZ,
    mix_bass_with_highpassed_drums_for_transcription,
)
from earcopy_service.transcription_inputs import (
    DEFAULT_PITCHED_TIMING_GUIDE_GAINS,
)


BENCHMARK_INSTRUMENTS = frozenset(
    {
        "acoustic_piano",
        "string_ensemble",
        "acoustic_guitar",
        "distorted_electric_guitar",
        "brass_section",
    }
)


def _tracks_for_instruments(instrument_ids: list[str]) -> list[Track]:
    if len(instrument_ids) != len(set(instrument_ids)):
        raise ValueError("--instruments must not contain duplicates")
    if not 1 <= len(instrument_ids) <= 16:
        raise ValueError("--instruments must contain between 1 and 16 items")

    pitched_channel_index = 0
    tracks: list[Track] = []
    for order, instrument_id in enumerate(instrument_ids, start=1):
        instrument = get_instrument(instrument_id)
        if instrument.kind == "drums":
            midi_channel = 10
        else:
            midi_channel = PITCHED_MIDI_CHANNELS[pitched_channel_index]
            pitched_channel_index += 1
        tracks.append(
            Track(
                displayName=instrument.display_name_ja,
                instrumentId=instrument.id,
                kind=instrument.kind,
                color=TRACK_COLOR_PALETTE[order - 1],
                order=order,
                midiChannel=midi_channel,
                gmProgram=instrument.gm_program,
            )
        )
    return tracks


def _serialized_notes(notes: list[ResultNote]) -> list[dict[str, str | int | float]]:
    return [
        {
            "instrument": note.instrument,
            "pitch": note.pitch,
            "startSec": note.start_sec,
            "endSec": note.end_sec,
        }
        for note in notes
    ]


def _cross_instrument_duplicates(
    notes: list[ResultNote],
    onset_tolerance_sec: float = 0.03,
) -> dict[str, object]:
    clusters: list[list[ResultNote]] = []
    pitched_notes = [note for note in notes if note.instrument != "drums"]
    for note in sorted(
        pitched_notes,
        key=lambda item: (item.pitch, item.start_sec),
    ):
        cluster = next(
            (
                item
                for item in reversed(clusters)
                if item[0].pitch == note.pitch
                and abs(item[0].start_sec - note.start_sec)
                <= onset_tolerance_sec
            ),
            None,
        )
        if cluster is None:
            clusters.append([note])
        else:
            cluster.append(note)
    duplicates = [
        cluster
        for cluster in clusters
        if len({note.instrument for note in cluster}) > 1
    ]
    pairs = Counter(
        "+".join(sorted({note.instrument for note in cluster}))
        for cluster in duplicates
    )
    return {
        "groups": len(duplicates),
        "notes": sum(len(cluster) for cluster in duplicates),
        "instrumentSets": dict(sorted(pairs.items())),
    }


def _continuous_same_pitch_chains(
    notes: list[ResultNote],
    minimum_span_sec: float = 10.0,
    maximum_gap_sec: float = 0.02,
) -> int:
    by_key: dict[tuple[str, int], list[ResultNote]] = defaultdict(list)
    for note in notes:
        if note.instrument == "drums":
            continue
        by_key[(note.instrument, note.pitch)].append(note)

    count = 0
    for group in by_key.values():
        ordered = sorted(group, key=lambda note: (note.start_sec, note.end_sec))
        chain_start = 0.0
        chain_end = 0.0
        chain_note_count = 0
        for note in ordered:
            if chain_end == 0.0 or note.start_sec > chain_end + maximum_gap_sec:
                if (
                    chain_note_count >= 2
                    and chain_end - chain_start > minimum_span_sec
                ):
                    count += 1
                chain_start = note.start_sec
                chain_end = note.end_sec
                chain_note_count = 1
            else:
                chain_end = max(chain_end, note.end_sec)
                chain_note_count += 1
        if chain_note_count >= 2 and chain_end - chain_start > minimum_span_sec:
            count += 1
    return count


def _note_health(
    notes: list[ResultNote],
    duration_sec: float,
) -> dict[str, float | int | None]:
    durations = sorted(note.end_sec - note.start_sec for note in notes)
    short_pitched_notes = sum(
        note.instrument != "drums"
        and note.end_sec - note.start_sec <= 0.010001
        for note in notes
    )
    short_drum_notes = sum(
        note.instrument == "drums"
        and note.end_sec - note.start_sec <= 0.010001
        for note in notes
    )
    return {
        "durationSec": round(duration_sec, 3),
        "notesPerSec": round(len(notes) / duration_sec, 3)
        if duration_sec > 0
        else 0.0,
        "minimumNoteMs": round(durations[0] * 1000, 3)
        if durations
        else None,
        "medianNoteMs": round(median(durations) * 1000, 3)
        if durations
        else None,
        "maximumNoteSec": round(durations[-1], 3) if durations else None,
        "pitchedNotesAtOrBelow10Ms": short_pitched_notes,
        "drumNotesAtOrBelow10Ms": short_drum_notes,
        "notesOver10Sec": sum(duration > 10.0 for duration in durations),
        "notesStartingPastAudio": sum(
            note.start_sec >= duration_sec for note in notes
        ),
        "notesEndingPastAudio": sum(note.end_sec > duration_sec for note in notes),
        "continuousSamePitchChainsOver10Sec": _continuous_same_pitch_chains(
            notes
        ),
    }


def _write_audio_segment(
    source: Path,
    destination: Path,
    start_sec: float,
    duration_sec: float | None,
) -> float:
    info = soundfile.info(source)
    source_duration_sec = info.frames / info.samplerate
    if not 0 <= start_sec < source_duration_sec:
        raise ValueError("--start is outside the source audio")
    selected_duration_sec = (
        source_duration_sec - start_sec
        if duration_sec is None
        else min(duration_sec, source_duration_sec - start_sec)
    )
    if selected_duration_sec <= 0:
        raise ValueError("--duration must select a non-empty interval")
    start_frame = round(start_sec * info.samplerate)
    stop_frame = start_frame + round(selected_duration_sec * info.samplerate)
    audio, sample_rate = soundfile.read(
        source,
        start=start_frame,
        stop=stop_frame,
        dtype="float32",
        always_2d=True,
    )
    soundfile.write(destination, audio, sample_rate, subtype="FLOAT")
    return len(audio) / sample_rate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--stem-model", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--reference-midi", type=Path)
    parser.add_argument("--ignore-instruments", action="store_true")
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--user-data", type=Path)
    parser.add_argument("--all-preset-tracks", action="store_true")
    parser.add_argument("--automatic-instruments", action="store_true")
    parser.add_argument("--instruments", nargs="+")
    parser.add_argument(
        "--mode",
        choices=("direct", "separated"),
        default="separated",
    )
    parser.add_argument(
        "--backend",
        choices=("Auto", "CPU", "CUDA"),
        default="CUDA",
    )
    parser.add_argument(
        "--dtype",
        choices=("float16", "float32"),
        default="float16",
    )
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--duration", type=float)
    parser.add_argument(
        "--drum-onset-guide",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument(
        "--timing-guide-note-filter",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument(
        "--timing-guide-scope",
        choices=("all", "pitched", "drums", "none"),
        default="pitched",
    )
    parser.add_argument(
        "--guide-instrument-rejection",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--timing-guide-gain-bass",
        type=float,
        default=DEFAULT_PITCHED_TIMING_GUIDE_GAINS["bass"],
    )
    parser.add_argument(
        "--bass-timing-guide-highpass-hz",
        type=float,
        default=BASS_DRUM_GUIDE_HIGHPASS_HZ,
    )
    parser.add_argument(
        "--timing-guide-gain-piano",
        type=float,
        default=DEFAULT_PITCHED_TIMING_GUIDE_GAINS["piano"],
    )
    parser.add_argument(
        "--timing-guide-gain-guitar",
        type=float,
        default=DEFAULT_PITCHED_TIMING_GUIDE_GAINS["guitar"],
    )
    parser.add_argument(
        "--timing-guide-gain-vocals",
        type=float,
        default=DEFAULT_PITCHED_TIMING_GUIDE_GAINS["vocals"],
    )
    parser.add_argument(
        "--timing-guide-gain-other",
        type=float,
        default=DEFAULT_PITCHED_TIMING_GUIDE_GAINS["other"],
    )
    parser.add_argument(
        "--fixed-family-expansion",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--fixed-family-duplicate-collapse",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    args = parser.parse_args()
    timing_guide_gains = {
        "bass": args.timing_guide_gain_bass,
        "piano": args.timing_guide_gain_piano,
        "guitar": args.timing_guide_gain_guitar,
        "vocals": args.timing_guide_gain_vocals,
        "other": args.timing_guide_gain_other,
    }
    invalid_guide_gains = {
        name: gain
        for name, gain in timing_guide_gains.items()
        if not 0.0 <= gain <= 1.0
    }
    if invalid_guide_gains:
        parser.error("timing guide gains must be between 0 and 1")
    if (
        not math.isfinite(args.bass_timing_guide_highpass_hz)
        or args.bass_timing_guide_highpass_hz <= 0.0
    ):
        parser.error("bass timing guide high-pass frequency must be positive")

    project = create_project("benchmark", PRESET_BY_KEY["anime-song"])
    if args.automatic_instruments:
        tracks = []
    elif args.instruments:
        tracks = _tracks_for_instruments(args.instruments)
    elif args.all_preset_tracks:
        tracks = project.tracks
    else:
        tracks = [
            track
            for track in project.tracks
            if track.instrument_id in BENCHMARK_INSTRUMENTS
        ]

    with tempfile.TemporaryDirectory(
        prefix="earcopy-job-benchmark-"
    ) as temporary:
        temporary_path = Path(temporary)
        input_audio = args.audio.resolve()
        source_info = soundfile.info(input_audio)
        source_duration_sec = source_info.frames / source_info.samplerate
        if args.start or args.duration is not None:
            input_audio = temporary_path / "selected-audio.wav"
            selected_duration_sec = _write_audio_segment(
                args.audio.resolve(),
                input_audio,
                args.start,
                args.duration,
            )
        else:
            selected_duration_sec = source_duration_sec
        previous_user_data = os.environ.get("EARCOPY_USER_DATA")
        previous_stem_model = os.environ.get("EARCOPY_STEM_MODEL_DIR")
        user_data = (
            args.user_data.resolve()
            if args.user_data is not None
            else Path(temporary) / "UserData"
        )
        os.environ["EARCOPY_USER_DATA"] = str(user_data)
        os.environ["EARCOPY_STEM_MODEL_DIR"] = str(args.stem_model.resolve())
        guide_inputs_by_scope = {
            "all": frozenset(
                {
                    "drums",
                    "bass",
                    "vocals",
                    "piano",
                    "guitar",
                    "other",
                }
            ),
            "pitched": frozenset(
                {
                    "bass",
                    "vocals",
                    "piano",
                    "guitar",
                    "other",
                }
            ),
            "drums": frozenset({"drums"}),
            "none": frozenset(),
        }
        method_policy = TranscriptionMethodPolicy(
            timing_guide_inputs=guide_inputs_by_scope[
                args.timing_guide_scope
            ],
            timing_guide_gains=timing_guide_gains,
            reject_timing_guide_events=args.guide_instrument_rejection,
            expand_fixed_instrument_families=args.fixed_family_expansion,
            collapse_fixed_instrument_family_duplicates=(
                args.fixed_family_duplicate_collapse
            ),
        )
        try:
            manager_options = {
                "transcription_method_policy": method_policy,
            }
            if (
                args.bass_timing_guide_highpass_hz
                != BASS_DRUM_GUIDE_HIGHPASS_HZ
            ):
                cutoff_hz = args.bass_timing_guide_highpass_hz
                cutoff_token = f"{cutoff_hz:g}".replace(".", "p")

                def mix_bass_timing_guide(
                    bass_path,
                    drums_path,
                    guide_gain,
                    output_path,
                    cancel_check,
                ):
                    benchmark_output = output_path.with_name(
                        f"{output_path.stem}-hpf{cutoff_token}"
                        f"{output_path.suffix}"
                    )
                    return mix_bass_with_highpassed_drums_for_transcription(
                        bass_path,
                        drums_path,
                        guide_gain,
                        benchmark_output,
                        cancel_check,
                        cutoff_hz=cutoff_hz,
                    )

                manager_options["bass_timing_guide_mixer"] = (
                    mix_bass_timing_guide
                )
            if args.ffmpeg is not None:
                manager = TranscriptionJobManager(
                    audio_preparer=lambda source: prepare_analysis_audio(
                        source,
                        temporary_path / "UserData" / "cache" / "audio",
                        ffmpeg_executable=str(args.ffmpeg.resolve()),
                    ),
                    **manager_options,
                )
            else:
                manager = TranscriptionJobManager(**manager_options)
            started_at = time.perf_counter()
            job_id = manager.start(
                TranscriptionJobRequest(
                    audioPath=str(input_audio),
                    modelPath=str(args.model.resolve()),
                    backend=args.backend,
                    dtype=args.dtype,
                    drumOnsetGuide=args.drum_onset_guide,
                    timingGuideNoteFilter=(
                        args.timing_guide_note_filter
                    ),
                    mode=args.mode,
                    instrumentSelectionMode=(
                        "automatic"
                        if args.automatic_instruments
                        else "fixed"
                    ),
                    tracks=tracks,
                )
            )
            status = manager.wait_for_terminal(job_id, timeout=900)
            elapsed_sec = time.perf_counter() - started_at
            events = [event.data for event in manager.events(job_id)]
        finally:
            if previous_user_data is None:
                os.environ.pop("EARCOPY_USER_DATA", None)
            else:
                os.environ["EARCOPY_USER_DATA"] = previous_user_data
            if previous_stem_model is None:
                os.environ.pop("EARCOPY_STEM_MODEL_DIR", None)
            else:
                os.environ["EARCOPY_STEM_MODEL_DIR"] = previous_stem_model

    if status != "completed":
        errors = [event for event in events if event.get("type") == "error"]
        raise RuntimeError(f"Transcription failed: {status} {errors}")
    note_events = [event for event in events if event.get("type") == "note"]
    partial_results = [
        event for event in events if event.get("type") == "partial_result"
    ]
    predicted = [
        ResultNote(
            instrument=event["sourceInstrumentId"],
            pitch=event["pitch"],
            start_sec=event["rawStartSec"],
            end_sec=event["rawEndSec"],
        )
        for event in note_events
    ]
    output_instrument_by_track_id = {
        str(track.id): track.instrument_id for track in tracks
    }
    output_predicted = [
        ResultNote(
            instrument=output_instrument_by_track_id.get(
                str(event["trackId"]), event["sourceInstrumentId"]
            ),
            pitch=event["pitch"],
            start_sec=event["rawStartSec"],
            end_sec=event["rawEndSec"],
        )
        for event in note_events
    ]
    scored_predicted = predicted if args.ignore_instruments else output_predicted
    reference = None
    if args.reference_midi is not None:
        reference = _reference_notes(
            args.reference_midi,
            include_unmapped=args.ignore_instruments,
        )
        if args.start or args.duration is not None:
            reference = _crop_reference_notes(
                reference,
                start_sec=args.start,
                duration_sec=selected_duration_sec,
            )
    score = (
        _reference_score(
            scored_predicted,
            reference,
            match_instruments=not args.ignore_instruments,
        )
        if reference is not None
        else None
    )
    notation_score = (
        {
            "onset": _notation_score(
                scored_predicted,
                reference,
                match_instruments=not args.ignore_instruments,
            ),
            "onsetOffset": _notation_score(
                scored_predicted,
                reference,
                require_offset=True,
                match_instruments=not args.ignore_instruments,
            ),
        }
        if reference is not None
        else None
    )
    scores_by_onset_tolerance_ms = (
        {
            str(tolerance_ms): _reference_score(
                scored_predicted,
                reference,
                onset_tolerance_sec=tolerance_ms / 1000,
                match_instruments=not args.ignore_instruments,
            )
            for tolerance_ms in (50, 120)
        }
        if reference is not None
        else None
    )
    result = {
        "status": status,
        "elapsedSec": round(elapsed_sec, 3),
        "settings": {
            "mode": args.mode,
            "backend": args.backend,
            "dtype": args.dtype,
            "instrumentSelectionMode": (
                "automatic" if args.automatic_instruments else "fixed"
            ),
            "drumOnsetGuide": args.drum_onset_guide,
            "timingGuideNoteFilter": (
                args.timing_guide_note_filter
            ),
            "timingGuideScope": args.timing_guide_scope,
            "timingGuideGains": timing_guide_gains,
            "bassTimingGuideHighpassHz": (
                args.bass_timing_guide_highpass_hz
            ),
            "guideInstrumentRejection": args.guide_instrument_rejection,
            "fixedFamilyExpansion": args.fixed_family_expansion,
            "fixedFamilyDuplicateCollapse": (
                args.fixed_family_duplicate_collapse
            ),
        },
        "score": score,
        "notationScore": notation_score,
        "scoresByOnsetToleranceMs": scores_by_onset_tolerance_ms,
        "noteCount": len(predicted),
        "notes": _serialized_notes(predicted),
        "outputNotes": _serialized_notes(output_predicted),
        "segment": {
            "startSec": round(args.start, 3),
            "durationSec": round(selected_duration_sec, 3),
            "sourceDurationSec": round(source_duration_sec, 3),
        },
        "health": _note_health(predicted, selected_duration_sec),
        "instruments": dict(
            sorted(Counter(note.instrument for note in predicted).items())
        ),
        "crossInstrumentDuplicates": _cross_instrument_duplicates(predicted),
        "inputDiagnostics": [
            {
                key: event.get(key)
                for key in (
                    "inputName",
                    "noteCount",
                    "assembledNoteCount",
                    "invalidChunkCount",
                    "invalidChunkDiscardedNoteCount",
                    "audioTailDiscardedNoteCount",
                    "audioTailTruncatedNoteCount",
                    "pathologicalChainCount",
                    "pathologicalChainDiscardedNoteCount",
                    "mappedDuplicateDiscardedNoteCount",
                    "timingGuideUnmodifiedNoteCount",
                    "timingGuideNoteDiscardedCount",
                    "timingGuideFilterCacheHit",
                )
            }
            for event in partial_results
        ],
        "states": [
            event["status"]
            for event in events
            if event.get("type") == "state"
        ],
    }
    rendered_result = json.dumps(result, indent=2)
    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(rendered_result + "\n", encoding="utf-8")
    print(rendered_result)


if __name__ == "__main__":
    main()
