from __future__ import annotations

import argparse
import gc
import hashlib
import itertools
import json
import tempfile
import time
from collections import Counter, defaultdict, deque
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np
import mido
import soundfile as sf
import torch
from muscriptor import TranscriptionModel

from earcopy_service.backends.muscriptor import _load_model


@dataclass(frozen=True, slots=True)
class ResultNote:
    instrument: str
    pitch: int
    start_sec: float
    end_sec: float


@dataclass(frozen=True, slots=True)
class VariantResult:
    name: str
    seconds: float
    peak_allocated_mib: int
    peak_reserved_mib: int
    notes: list[ResultNote]


PROGRAM_INSTRUMENTS = {
    **dict.fromkeys(range(0, 4), "acoustic_piano"),
    **dict.fromkeys(range(4, 8), "electric_piano"),
    **dict.fromkeys(range(8, 16), "chromatic_percussion"),
    **dict.fromkeys(range(16, 24), "organ"),
    **dict.fromkeys(range(24, 26), "acoustic_guitar"),
    **dict.fromkeys(range(26, 29), "clean_electric_guitar"),
    **dict.fromkeys(range(29, 32), "distorted_electric_guitar"),
    32: "acoustic_bass",
    **dict.fromkeys(range(33, 40), "electric_bass"),
    40: "violin",
    41: "viola",
    42: "cello",
    43: "contrabass",
    44: "string_ensemble",
    45: "string_ensemble",
    46: "orchestral_harp",
    47: "timpani",
    48: "string_ensemble",
    49: "string_ensemble",
    **dict.fromkeys(range(50, 52), "synth_strings"),
    **dict.fromkeys(range(52, 55), "voice"),
    55: "orchestra_hit",
    56: "trumpet",
    57: "trombone",
    58: "tuba",
    59: "trumpet",
    60: "french_horn",
    **dict.fromkeys(range(61, 64), "brass_section"),
    **dict.fromkeys(range(64, 66), "soprano_and_alto_sax"),
    66: "tenor_sax",
    67: "baritone_sax",
    68: "oboe",
    69: "english_horn",
    70: "bassoon",
    71: "clarinet",
    **dict.fromkeys(range(72, 80), "flutes"),
    **dict.fromkeys(range(80, 88), "synth_lead"),
    **dict.fromkeys(range(88, 96), "synth_pad"),
    112: "chromatic_percussion",
    113: "chromatic_percussion",
    114: "chromatic_percussion",
    115: "chromatic_percussion",
    117: "chromatic_percussion",
    118: "chromatic_percussion",
}
RESULT_CACHE_VERSION = 2


def _write_variant(
    source: Path,
    destination: Path,
    start_sec: float,
    duration_sec: float,
    leading_silence_sec: float,
) -> None:
    info = sf.info(source)
    start_frame = round(start_sec * info.samplerate)
    stop_frame = start_frame + round(duration_sec * info.samplerate)
    audio, sample_rate = sf.read(
        source,
        start=start_frame,
        stop=stop_frame,
        dtype="float32",
        always_2d=True,
    )
    silence_frames = round(leading_silence_sec * sample_rate)
    if silence_frames:
        silence = np.zeros(
            (silence_frames, audio.shape[1]),
            dtype=np.float32,
        )
        audio = np.concatenate((silence, audio), axis=0)
    sf.write(destination, audio, sample_rate, subtype="FLOAT")


def _decode_notes(
    events: list[Any],
    shift_sec: float,
    duration_sec: float,
) -> list[ResultNote]:
    starts = {
        int(event.index): event
        for event in events
        if all(
            hasattr(event, name)
            for name in ("index", "instrument", "pitch", "start_time")
        )
    }
    notes: list[ResultNote] = []
    for event in events:
        if not all(
            hasattr(event, name)
            for name in ("start_event_index", "end_time")
        ):
            continue
        start = starts.get(int(event.start_event_index))
        if start is None:
            continue
        start_sec = float(start.start_time) - shift_sec
        end_sec = float(event.end_time) - shift_sec
        if end_sec <= 0 or start_sec >= duration_sec:
            continue
        start_sec = max(0.0, start_sec)
        end_sec = min(duration_sec, end_sec)
        if end_sec <= start_sec:
            continue
        notes.append(
            ResultNote(
                instrument=str(start.instrument),
                pitch=int(start.pitch),
                start_sec=round(start_sec, 4),
                end_sec=round(end_sec, 4),
            )
        )
    return sorted(
        notes,
        key=lambda note: (
            note.start_sec,
            note.pitch,
            note.instrument,
            note.end_sec,
        ),
    )


def _run_variant(
    model: Any,
    name: str,
    audio_path: Path,
    instruments: list[str] | None,
    beam_size: int,
    shift_sec: float,
    duration_sec: float,
    use_sampling: bool = False,
    temperature: float = 1.0,
    seed: int = 0,
    output_instruments: list[str] | None = None,
) -> VariantResult:
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    events = list(
        model.transcribe(
            audio_path,
            instruments=instruments,
            prelude_forcing=True,
            beam_size=beam_size,
            use_sampling=use_sampling,
            temperature=temperature,
        )
    )
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    notes = _decode_notes(events, shift_sec, duration_sec)
    if output_instruments is not None:
        allowed = set(output_instruments)
        notes = [note for note in notes if note.instrument in allowed]
    return VariantResult(
        name=name,
        seconds=round(elapsed, 2),
        peak_allocated_mib=round(
            torch.cuda.max_memory_allocated() / 1024**2
        ),
        peak_reserved_mib=round(
            torch.cuda.max_memory_reserved() / 1024**2
        ),
        notes=notes,
    )


def _fuse_consensus(
    results: list[VariantResult],
    min_support: int,
    onset_tolerance_sec: float = 0.12,
) -> list[ResultNote]:
    clusters: list[list[tuple[int, ResultNote]]] = []
    for source_index, result in enumerate(results):
        for note in result.notes:
            candidates = [
                cluster
                for cluster in clusters
                if note.pitch == cluster[0][1].pitch
                and source_index
                not in {member_source for member_source, _ in cluster}
                and abs(
                    note.start_sec
                    - median(member.start_sec for _, member in cluster)
                )
                <= onset_tolerance_sec
            ]
            if candidates:
                cluster = min(
                    candidates,
                    key=lambda item: abs(
                        note.start_sec
                        - median(member.start_sec for _, member in item)
                    ),
                )
                cluster.append((source_index, note))
            else:
                clusters.append([(source_index, note)])

    fused: list[ResultNote] = []
    for cluster in clusters:
        if len(cluster) < min_support:
            continue
        instrument_counts = Counter(
            note.instrument for _, note in cluster
        )
        max_votes = max(instrument_counts.values())
        tied = {
            instrument
            for instrument, votes in instrument_counts.items()
            if votes == max_votes
        }
        baseline = next(
            (note.instrument for source, note in cluster if source == 0),
            None,
        )
        instrument = (
            baseline
            if baseline in tied
            else sorted(tied)[0]
        )
        fused.append(
            ResultNote(
                instrument=instrument,
                pitch=cluster[0][1].pitch,
                start_sec=round(
                    median(note.start_sec for _, note in cluster),
                    4,
                ),
                end_sec=round(
                    median(note.end_sec for _, note in cluster),
                    4,
                ),
            )
        )
    return sorted(
        fused,
        key=lambda note: (
            note.start_sec,
            note.pitch,
            note.instrument,
            note.end_sec,
        ),
    )


def _match_counts(
    left: list[ResultNote],
    right: list[ResultNote],
    onset_tolerance_sec: float = 0.12,
) -> dict[str, float | int]:
    unused = set(range(len(right)))
    pitch_matches = 0
    instrument_matches = 0
    for note in left:
        candidates = [
            index
            for index in unused
            if right[index].pitch == note.pitch
            and abs(right[index].start_sec - note.start_sec)
            <= onset_tolerance_sec
        ]
        if not candidates:
            continue
        match_index = min(
            candidates,
            key=lambda index: abs(
                right[index].start_sec - note.start_sec
            ),
        )
        unused.remove(match_index)
        pitch_matches += 1
        if right[match_index].instrument == note.instrument:
            instrument_matches += 1
    denominator = max(len(left), len(right), 1)
    return {
        "leftNotes": len(left),
        "rightNotes": len(right),
        "pitchMatches": pitch_matches,
        "instrumentMatches": instrument_matches,
        "pitchAgreement": round(pitch_matches / denominator, 4),
        "instrumentAgreement": round(
            instrument_matches / denominator,
            4,
        ),
    }


def _polyphony_stats(notes: list[ResultNote]) -> dict[str, dict[str, int]]:
    stats: dict[str, dict[str, int]] = {}
    by_instrument: defaultdict[str, list[tuple[float, int]]] = defaultdict(list)
    for note in notes:
        by_instrument[note.instrument].append((note.start_sec, 1))
        by_instrument[note.instrument].append((note.end_sec, -1))
    for instrument, events in sorted(by_instrument.items()):
        active = 0
        maximum = 0
        starts_at_maximum = 0
        for _time_sec, delta in sorted(events, key=lambda item: (item[0], item[1])):
            active += delta
            if delta > 0 and active > maximum:
                maximum = active
                starts_at_maximum = 1
            elif delta > 0 and active == maximum:
                starts_at_maximum += 1
        stats[instrument] = {
            "maximum": maximum,
            "startsAtMaximum": starts_at_maximum,
        }
    return stats


def _load_pitch_evidence(
    audio_path: Path,
    start_sec: float,
    duration_sec: float,
) -> tuple[np.ndarray, int, int, int]:
    import librosa

    sample_rate = 22_050
    hop_length = 256
    minimum_midi = 24
    audio, _ = librosa.load(
        audio_path,
        sr=sample_rate,
        mono=True,
        offset=start_sec,
        duration=duration_sec,
    )
    cqt = np.abs(
        librosa.cqt(
            audio,
            sr=sample_rate,
            hop_length=hop_length,
            fmin=float(librosa.midi_to_hz(minimum_midi)),
            n_bins=84,
            bins_per_octave=12,
        )
    )
    return cqt, sample_rate, hop_length, minimum_midi


def _pitch_contrast_scores(
    notes: list[ResultNote],
    evidence: tuple[np.ndarray, int, int, int],
) -> list[float]:
    cqt, sample_rate, hop_length, minimum_midi = evidence
    scores: list[float] = []
    epsilon = np.finfo(np.float32).eps
    for note in notes:
        if note.instrument == "drums":
            scores.append(float("inf"))
            continue
        pitch_bin = note.pitch - minimum_midi
        if not 0 <= pitch_bin < cqt.shape[0]:
            scores.append(float("inf"))
            continue
        first_frame = max(0, round(note.start_sec * sample_rate / hop_length))
        evidence_end = min(note.end_sec, note.start_sec + 0.2)
        last_frame = max(
            first_frame + 1,
            round(evidence_end * sample_rate / hop_length) + 1,
        )
        last_frame = min(cqt.shape[1], last_frame)
        if first_frame >= last_frame:
            scores.append(float("inf"))
            continue
        target = float(np.percentile(cqt[pitch_bin, first_frame:last_frame], 75))
        neighbor_bins = [
            index
            for offset in (-3, -2, -1, 1, 2, 3)
            if 0 <= (index := pitch_bin + offset) < cqt.shape[0]
        ]
        if not neighbor_bins:
            scores.append(float("inf"))
            continue
        neighbors = [
            float(np.percentile(cqt[index, first_frame:last_frame], 75))
            for index in neighbor_bins
        ]
        background = float(np.median(neighbors))
        scores.append(20.0 * float(np.log10((target + epsilon) / (background + epsilon))))
    return scores


def _filter_by_pitch_contrast(
    notes: list[ResultNote],
    scores: list[float],
    minimum_contrast_db: float,
) -> list[ResultNote]:
    return [
        note
        for note, score in zip(notes, scores, strict=True)
        if score >= minimum_contrast_db
    ]


def _reference_notes(
    path: Path,
    *,
    include_unmapped: bool = False,
) -> list[ResultNote]:
    midi = mido.MidiFile(path)
    programs: dict[int, int] = {}
    active: defaultdict[
        tuple[int, int],
        deque[tuple[str, float]],
    ] = defaultdict(deque)
    notes: list[ResultNote] = []
    absolute_sec = 0.0
    tempo = mido.bpm2tempo(120)
    for message in mido.merge_tracks(midi.tracks):
        absolute_sec += mido.tick2second(
            message.time,
            midi.ticks_per_beat,
            tempo,
        )
        if message.type == "set_tempo":
            tempo = message.tempo
            continue
        if message.type == "program_change":
            programs[message.channel] = message.program
            continue
        if message.type == "note_on" and message.velocity > 0:
            instrument = (
                "drums"
                if message.channel == 9
                else PROGRAM_INSTRUMENTS.get(
                    programs.get(message.channel, -1)
                )
            )
            if instrument is not None or include_unmapped:
                active[(message.channel, message.note)].append(
                    (instrument or "unmapped", absolute_sec)
                )
            continue
        if message.type not in ("note_off", "note_on"):
            continue
        key = (message.channel, message.note)
        starts = active.get(key)
        if not starts:
            continue
        instrument, start_sec = starts.popleft()
        if not starts:
            active.pop(key, None)
        notes.append(
            ResultNote(
                instrument=instrument,
                pitch=message.note,
                start_sec=round(start_sec, 4),
                end_sec=round(absolute_sec, 4),
            )
        )
    return sorted(notes, key=lambda note: (note.start_sec, note.pitch))


def _crop_reference_notes(
    notes: list[ResultNote],
    start_sec: float,
    duration_sec: float,
) -> list[ResultNote]:
    stop_sec = start_sec + duration_sec
    return [
        ResultNote(
            instrument=note.instrument,
            pitch=note.pitch,
            start_sec=round(note.start_sec - start_sec, 4),
            end_sec=round(min(note.end_sec, stop_sec) - start_sec, 4),
        )
        for note in notes
        if start_sec <= note.start_sec < stop_sec
    ]


def _matched_onset_errors(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    onset_tolerance_sec: float,
    prediction_shift_sec: float = 0.0,
    match_instruments: bool = True,
) -> list[float]:
    unused = set(range(len(reference)))
    errors: list[float] = []
    for note in predicted:
        candidates = [
            index
            for index in unused
            if (
                not match_instruments
                or reference[index].instrument == note.instrument
            )
            and reference[index].pitch == note.pitch
            and abs(
                reference[index].start_sec
                - (note.start_sec + prediction_shift_sec)
            )
            <= onset_tolerance_sec
        ]
        if not candidates:
            continue
        match_index = min(
            candidates,
            key=lambda index: abs(
                reference[index].start_sec
                - (note.start_sec + prediction_shift_sec)
            ),
        )
        unused.remove(match_index)
        errors.append(
            note.start_sec
            + prediction_shift_sec
            - reference[match_index].start_sec
        )
    return errors


def _onset_timing(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    onset_tolerance_sec: float,
    match_instruments: bool = True,
) -> dict[str, float | int | None]:
    errors = _matched_onset_errors(
        predicted,
        reference,
        onset_tolerance_sec,
        match_instruments=match_instruments,
    )
    shifts = (value / 100 for value in range(-60, 61))
    best_shift, best_errors = max(
        (
            (
                shift,
                _matched_onset_errors(
                    predicted,
                    reference,
                    onset_tolerance_sec,
                    shift,
                    match_instruments,
                ),
            )
            for shift in shifts
        ),
        key=lambda item: (
            len(item[1]),
            -(
                float(np.median(np.abs(item[1])))
                if item[1]
                else float("inf")
            ),
            -abs(item[0]),
        ),
    )
    return {
        "matchedNotes": len(errors),
        "medianPredictionErrorMs": (
            round(float(np.median(errors)) * 1000, 1) if errors else None
        ),
        "p95AbsoluteErrorMs": (
            round(float(np.percentile(np.abs(errors), 95)) * 1000, 1)
            if errors
            else None
        ),
        "bestGlobalCorrectionMs": round(best_shift * 1000),
        "matchesAtBestCorrection": len(best_errors),
    }


def _reference_score(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    onset_tolerance_sec: float = 0.12,
    match_instruments: bool = True,
) -> dict[str, object]:
    timing = _onset_timing(
        predicted,
        reference,
        onset_tolerance_sec,
        match_instruments,
    )
    matches = int(timing["matchedNotes"])
    false_positives = len(predicted) - matches
    false_negatives = len(reference) - matches
    precision = matches / len(predicted) if predicted else 0.0
    recall = matches / len(reference) if reference else 0.0
    f1_denominator = 2 * matches + false_positives + false_negatives
    f1 = (
        2 * matches / f1_denominator
        if f1_denominator
        else 0.0
    )
    return {
        "referenceNotes": len(reference),
        "predictedNotes": len(predicted),
        "matches": matches,
        "falsePositiveNotes": false_positives,
        "falseNegativeNotes": false_negatives,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "timing": timing,
        "timingByInstrument": (
            {
                instrument: _onset_timing(
                    [note for note in predicted if note.instrument == instrument],
                    [note for note in reference if note.instrument == instrument],
                    onset_tolerance_sec,
                )
                for instrument in sorted(
                    {note.instrument for note in reference}
                )
            }
            if match_instruments
            else {}
        ),
    }


def _maximum_note_matches(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    *,
    onset_tolerance_sec: float,
    require_offset: bool,
    match_instruments: bool,
) -> list[tuple[int, int]]:
    """Return a maximum one-to-one matching for notation-oriented scoring."""

    adjacency: list[list[int]] = []
    for predicted_note in predicted:
        candidates: list[tuple[float, float, int]] = []
        for reference_index, reference_note in enumerate(reference):
            if predicted_note.pitch != reference_note.pitch:
                continue
            if (
                match_instruments
                and predicted_note.instrument != reference_note.instrument
            ):
                continue
            onset_error = abs(
                predicted_note.start_sec - reference_note.start_sec
            )
            if onset_error > onset_tolerance_sec:
                continue
            offset_error = abs(predicted_note.end_sec - reference_note.end_sec)
            if require_offset:
                reference_duration = max(
                    0.0,
                    reference_note.end_sec - reference_note.start_sec,
                )
                offset_tolerance = max(0.05, reference_duration * 0.2)
                if offset_error > offset_tolerance:
                    continue
            candidates.append((onset_error, offset_error, reference_index))
        adjacency.append(
            [reference_index for _, _, reference_index in sorted(candidates)]
        )

    reference_to_prediction: dict[int, int] = {}

    def augment(prediction_index: int, visited: set[int]) -> bool:
        for reference_index in adjacency[prediction_index]:
            if reference_index in visited:
                continue
            visited.add(reference_index)
            incumbent = reference_to_prediction.get(reference_index)
            if incumbent is None or augment(incumbent, visited):
                reference_to_prediction[reference_index] = prediction_index
                return True
        return False

    prediction_order = sorted(
        range(len(predicted)),
        key=lambda index: (
            len(adjacency[index]),
            predicted[index].start_sec,
            predicted[index].pitch,
            index,
        ),
    )
    for prediction_index in prediction_order:
        augment(prediction_index, set())
    return sorted(
        (
            (prediction_index, reference_index)
            for reference_index, prediction_index
            in reference_to_prediction.items()
        ),
        key=lambda item: (
            predicted[item[0]].start_sec,
            predicted[item[0]].pitch,
            item[0],
        ),
    )


def _maximum_timing_credit(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    *,
    match_tolerance_sec: float,
    timing_penalty_sec: float,
    match_instruments: bool,
) -> float:
    if match_tolerance_sec <= 0.0:
        raise ValueError("match_tolerance_sec must be positive")
    if timing_penalty_sec <= 0.0:
        raise ValueError("timing_penalty_sec must be positive")

    predicted_groups: dict[tuple[str, int] | int, list[ResultNote]] = defaultdict(list)
    reference_groups: dict[tuple[str, int] | int, list[ResultNote]] = defaultdict(list)

    def key(note: ResultNote) -> tuple[str, int] | int:
        return (note.instrument, note.pitch) if match_instruments else note.pitch

    for note in predicted:
        predicted_groups[key(note)].append(note)
    for note in reference:
        reference_groups[key(note)].append(note)

    total_credit = 0.0
    for group_key in predicted_groups.keys() & reference_groups.keys():
        predicted_notes = sorted(
            predicted_groups[group_key], key=lambda note: note.start_sec
        )
        reference_notes = sorted(
            reference_groups[group_key], key=lambda note: note.start_sec
        )
        previous = [0.0] * (len(reference_notes) + 1)
        for predicted_note in predicted_notes:
            current = [0.0] * (len(reference_notes) + 1)
            for reference_index, reference_note in enumerate(
                reference_notes, start=1
            ):
                error = abs(
                    predicted_note.start_sec - reference_note.start_sec
                )
                match_credit = (
                    max(0.0, 1.0 - error / timing_penalty_sec)
                    if error <= match_tolerance_sec
                    else 0.0
                )
                current[reference_index] = max(
                    previous[reference_index],
                    current[reference_index - 1],
                    previous[reference_index - 1] + match_credit,
                )
            previous = current
        total_credit += previous[-1]
    return total_credit


def _timing_and_mismatch_score(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    *,
    onset_tolerance_sec: float = 0.12,
    timing_penalty_sec: float = 0.05,
    match_instruments: bool = True,
) -> dict[str, int | float]:
    matches = _maximum_note_matches(
        predicted,
        reference,
        onset_tolerance_sec=onset_tolerance_sec,
        require_offset=False,
        match_instruments=match_instruments,
    )
    matched_notes = len(matches)
    false_positives = len(predicted) - matched_notes
    false_negatives = len(reference) - matched_notes
    denominator = len(predicted) + len(reference)
    timing_credit = _maximum_timing_credit(
        predicted,
        reference,
        match_tolerance_sec=onset_tolerance_sec,
        timing_penalty_sec=timing_penalty_sec,
        match_instruments=match_instruments,
    )
    return {
        "matches": matched_notes,
        "falsePositiveNotes": false_positives,
        "falseNegativeNotes": false_negatives,
        "falsePositiveRate": round(
            false_positives / len(predicted) if predicted else 0.0,
            4,
        ),
        "falseNegativeRate": round(
            false_negatives / len(reference) if reference else 0.0,
            4,
        ),
        "mismatchRate": round(
            (false_positives + false_negatives) / denominator
            if denominator
            else 0.0,
            4,
        ),
        "timingCredit": round(timing_credit, 6),
        "onsetTimingScore": round(
            timing_credit / matched_notes if matched_notes else 0.0,
            4,
        ),
        "score": round(
            2.0 * timing_credit / denominator if denominator else 0.0,
            4,
        ),
        "onsetToleranceMs": round(onset_tolerance_sec * 1000),
        "fullTimingPenaltyMs": round(timing_penalty_sec * 1000),
    }


def _aggregate_timing_and_mismatch(
    results: list[dict[str, Any]],
) -> dict[str, int | float]:
    reference_notes = sum(item["referenceNotes"] for item in results)
    predicted_notes = sum(item["predictedNotes"] for item in results)
    matched_notes = sum(
        item["timingAndMismatchScore"]["matches"] for item in results
    )
    false_positives = predicted_notes - matched_notes
    false_negatives = reference_notes - matched_notes
    timing_credit = sum(
        float(item["timingAndMismatchScore"]["timingCredit"])
        for item in results
    )
    denominator = predicted_notes + reference_notes
    return {
        "matches": matched_notes,
        "falsePositiveNotes": false_positives,
        "falseNegativeNotes": false_negatives,
        "falsePositiveRate": round(
            false_positives / predicted_notes if predicted_notes else 0.0,
            4,
        ),
        "falseNegativeRate": round(
            false_negatives / reference_notes if reference_notes else 0.0,
            4,
        ),
        "mismatchRate": round(
            (false_positives + false_negatives) / denominator
            if denominator
            else 0.0,
            4,
        ),
        "timingCredit": round(timing_credit, 6),
        "onsetTimingScore": round(
            timing_credit / matched_notes if matched_notes else 0.0,
            4,
        ),
        "score": round(
            2.0 * timing_credit / denominator if denominator else 0.0,
            4,
        ),
        "onsetToleranceMs": 120,
        "fullTimingPenaltyMs": 50,
    }


def _notation_score(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    *,
    onset_tolerance_sec: float = 0.05,
    require_offset: bool = False,
    match_instruments: bool = True,
) -> dict[str, object]:
    """Score exact pitches using standard onset and optional offset tolerances."""

    matches = _maximum_note_matches(
        predicted,
        reference,
        onset_tolerance_sec=onset_tolerance_sec,
        require_offset=require_offset,
        match_instruments=match_instruments,
    )
    false_positives = len(predicted) - len(matches)
    false_negatives = len(reference) - len(matches)
    precision = len(matches) / len(predicted) if predicted else 0.0
    recall = len(matches) / len(reference) if reference else 0.0
    f1_denominator = 2 * len(matches) + false_positives + false_negatives
    f1 = (
        2 * len(matches) / f1_denominator
        if f1_denominator
        else 0.0
    )
    onset_errors = [
        predicted[prediction_index].start_sec
        - reference[reference_index].start_sec
        for prediction_index, reference_index in matches
    ]
    offset_errors = [
        predicted[prediction_index].end_sec
        - reference[reference_index].end_sec
        for prediction_index, reference_index in matches
    ]
    return {
        "referenceNotes": len(reference),
        "predictedNotes": len(predicted),
        "matches": len(matches),
        "falsePositiveNotes": false_positives,
        "falseNegativeNotes": false_negatives,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "onsetToleranceMs": round(onset_tolerance_sec * 1000),
        "offsetRequired": require_offset,
        "timing": {
            "medianOnsetErrorMs": (
                round(float(np.median(onset_errors)) * 1000, 1)
                if onset_errors
                else None
            ),
            "p95AbsoluteOnsetErrorMs": (
                round(float(np.percentile(np.abs(onset_errors), 95)) * 1000, 1)
                if onset_errors
                else None
            ),
            "medianAbsoluteOffsetErrorMs": (
                round(float(np.median(np.abs(offset_errors))) * 1000, 1)
                if offset_errors
                else None
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--start", type=float, default=60.0)
    parser.add_argument("--duration", type=float, default=15.0)
    parser.add_argument("--shift", type=float, default=2.5)
    parser.add_argument("--reference-midi", type=Path)
    parser.add_argument("--reference-start", type=float)
    parser.add_argument("--ignore-instruments", action="store_true")
    parser.add_argument("--include-sampling", action="store_true")
    parser.add_argument("--include-isolated-instruments", action="store_true")
    parser.add_argument(
        "--variants",
        nargs="+",
        choices=(
            "beam1",
            "comparison-beam1",
            "auto-beam1",
            "shifted-beam1",
            "beam2",
            "beam4",
        ),
        default=("beam1", "shifted-beam1", "beam2"),
    )
    parser.add_argument(
        "--sampling-temperature",
        type=float,
        default=0.75,
    )
    parser.add_argument("--result-cache", type=Path)
    parser.add_argument("--output-json", type=Path)
    parser.add_argument(
        "--instruments",
        nargs="+",
        required=True,
    )
    parser.add_argument("--comparison-instruments", nargs="+")
    parser.add_argument("--output-instruments", nargs="+")
    args = parser.parse_args()

    cache_prefix = None
    if args.result_cache is not None:
        args.result_cache.mkdir(parents=True, exist_ok=True)
        cache_inputs = {
            "version": RESULT_CACHE_VERSION,
            "model": str(args.model.resolve()),
            "modelSize": args.model.stat().st_size,
            "modelMtime": args.model.stat().st_mtime_ns,
            "audio": str(args.audio.resolve()),
            "audioSize": args.audio.stat().st_size,
            "audioMtime": args.audio.stat().st_mtime_ns,
            "start": args.start,
            "duration": args.duration,
            "shift": args.shift,
            "instruments": args.instruments,
            "comparisonInstruments": args.comparison_instruments,
            "outputInstruments": args.output_instruments,
        }
        cache_prefix = hashlib.sha256(
            json.dumps(cache_inputs, sort_keys=True).encode("utf-8")
        ).hexdigest()[:16]

    with tempfile.TemporaryDirectory(prefix="earcopy-beam-") as temporary:
        temporary_path = Path(temporary)
        baseline = temporary_path / "baseline.wav"
        shifted = temporary_path / "shifted.wav"
        _write_variant(
            args.audio,
            baseline,
            args.start,
            args.duration,
            0.0,
        )
        _write_variant(
            args.audio,
            shifted,
            args.start,
            args.duration,
            args.shift,
        )

        model = _load_model(
            TranscriptionModel,
            args.model,
            "cuda",
            "float16",
            torch,
        )
        try:
            def run_variant(*variant_args: Any, **variant_kwargs: Any) -> VariantResult:
                name = str(variant_args[1])
                cache_path = (
                    args.result_cache / f"{cache_prefix}-{name}.json"
                    if args.result_cache is not None
                    else None
                )
                if cache_path is not None and cache_path.exists():
                    cached = json.loads(cache_path.read_text(encoding="utf-8"))
                    return VariantResult(
                        name=cached["name"],
                        seconds=cached["seconds"],
                        peak_allocated_mib=cached["peak_allocated_mib"],
                        peak_reserved_mib=cached["peak_reserved_mib"],
                        notes=[ResultNote(**note) for note in cached["notes"]],
                    )
                result = _run_variant(*variant_args, **variant_kwargs)
                if cache_path is not None:
                    cache_path.write_text(
                        json.dumps(asdict(result), indent=2),
                        encoding="utf-8",
                    )
                return result

            variant_specs = {
                "beam1": (
                    baseline,
                    1,
                    0.0,
                    args.instruments,
                    args.output_instruments,
                ),
                "comparison-beam1": (
                    baseline,
                    1,
                    0.0,
                    args.comparison_instruments or args.instruments,
                    args.output_instruments,
                ),
                "auto-beam1": (
                    baseline,
                    1,
                    0.0,
                    None,
                    args.output_instruments or args.instruments,
                ),
                "shifted-beam1": (
                    shifted,
                    1,
                    args.shift,
                    args.instruments,
                    args.output_instruments,
                ),
                "beam2": (
                    baseline,
                    2,
                    0.0,
                    args.instruments,
                    args.output_instruments,
                ),
                "beam4": (
                    baseline,
                    4,
                    0.0,
                    args.instruments,
                    args.output_instruments,
                ),
            }
            results = []
            for name in args.variants:
                (
                    audio_path,
                    beam_size,
                    shift_sec,
                    conditioned_instruments,
                    output_instruments,
                ) = variant_specs[name]
                results.append(
                    run_variant(
                        model,
                        name,
                        audio_path,
                        conditioned_instruments,
                        beam_size,
                        shift_sec,
                        args.duration,
                        output_instruments=output_instruments,
                    )
                )
            sampling_results: list[VariantResult] = []
            if args.include_sampling:
                sampling_results = [
                    run_variant(
                        model,
                        f"sample-{seed}",
                        baseline,
                        args.instruments,
                        1,
                        0.0,
                        args.duration,
                        use_sampling=True,
                        temperature=args.sampling_temperature,
                        seed=seed,
                        output_instruments=args.output_instruments,
                    )
                    for seed in (1, 2, 3)
                ]
                results.extend(sampling_results)
            isolated_results: list[VariantResult] = []
            if args.include_isolated_instruments:
                isolated_results = [
                    run_variant(
                        model,
                        f"isolated-{instrument}",
                        baseline,
                        [instrument],
                        1,
                        0.0,
                        args.duration,
                    )
                    for instrument in args.instruments
                ]
                results.extend(isolated_results)
        finally:
            del model
            gc.collect()
            torch.cuda.empty_cache()

    summary = []
    for result in results:
        summary.append(
            {
                **{
                    key: value
                    for key, value in asdict(result).items()
                    if key != "notes"
                },
                "noteCount": len(result.notes),
                "instruments": dict(
                    sorted(
                        Counter(
                            note.instrument for note in result.notes
                        ).items()
                    )
                ),
                "polyphony": _polyphony_stats(result.notes),
            }
        )
    comparisons = {
        f"{left.name}:{right.name}": _match_counts(left.notes, right.notes)
        for left, right in itertools.combinations(results, 2)
    }
    reference_scores = None
    fusion_scores = None
    isolated_score = None
    pitch_evidence_scores = None
    if args.reference_midi is not None:
        reference = _crop_reference_notes(
            _reference_notes(
                args.reference_midi,
                include_unmapped=args.ignore_instruments,
            ),
            (
                args.reference_start
                if args.reference_start is not None
                else args.start
            ),
            args.duration,
        )
        reference_scores = {
            result.name: _reference_score(
                result.notes,
                reference,
                match_instruments=not args.ignore_instruments,
            )
            for result in results
        }
        evidence = _load_pitch_evidence(
            args.audio,
            args.start,
            args.duration,
        )
        pitch_evidence_scores = {}
        for result in results:
            note_scores = _pitch_contrast_scores(result.notes, evidence)
            finite_scores = [score for score in note_scores if np.isfinite(score)]
            pitch_evidence_scores[result.name] = {
                "medianContrastDb": (
                    round(float(np.median(finite_scores)), 3)
                    if finite_scores
                    else None
                ),
                "thresholds": {
                    str(threshold): _reference_score(
                        _filter_by_pitch_contrast(
                            result.notes,
                            note_scores,
                            threshold,
                        ),
                        reference,
                        match_instruments=not args.ignore_instruments,
                    )
                    for threshold in (-6.0, -3.0, 0.0, 3.0, 6.0, 9.0)
                },
            }
        if args.include_sampling:
            baseline_result = next(
                (result for result in results if result.name == "beam1"),
                results[0],
            )
            ensemble = [baseline_result, *sampling_results]
            fusion_scores = {
                f"support-{support}": _reference_score(
                    _fuse_consensus(ensemble, support),
                    reference,
                    match_instruments=not args.ignore_instruments,
                )
                for support in (2, 3, 4)
            }
        if args.include_isolated_instruments:
            isolated_score = _reference_score(
                [
                    note
                    for result in isolated_results
                    for note in result.notes
                ],
                reference,
                match_instruments=not args.ignore_instruments,
            )
    rendered = json.dumps(
        {
            "variants": summary,
            "comparisons": comparisons,
            "referenceScores": reference_scores,
            "fusionScores": fusion_scores,
            "isolatedInstrumentScore": isolated_score,
            "pitchEvidenceScores": pitch_evidence_scores,
        },
        ensure_ascii=False,
        indent=2,
    )
    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
