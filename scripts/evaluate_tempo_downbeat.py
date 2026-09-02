from __future__ import annotations

import argparse
import json
import math
import statistics
import time
import wave
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

from earcopy_service.tempo_estimation import estimate_tempo


MATCH_TOLERANCE_SEC = 0.07


@dataclass(frozen=True, slots=True)
class EventMetrics:
    reference_count: int
    predicted_count: int
    matched_count: int
    precision: float
    recall: float
    f1: float


@dataclass(frozen=True, slots=True)
class TrackResult:
    track: str
    genre: str
    numerator: int
    reference_bpm: float
    estimated_bpm: float
    estimated_measure_offset_sec: float
    tempo_absolute_percent_error: float
    beat: EventMetrics
    downbeat: EventMetrics
    elapsed_sec: float


def read_annotations(path: Path) -> tuple[list[float], list[int]]:
    times = []
    labels = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 2:
            raise ValueError(
                f"{path}:{line_number}: expected time and beat label"
            )
        times.append(float(fields[0]))
        labels.append(int(fields[1]))
    if len(times) < 2:
        raise ValueError(f"{path}: at least two beat annotations are required")
    return times, labels


def match_events(
    reference: list[float],
    predicted: list[float],
    tolerance_sec: float = MATCH_TOLERANCE_SEC,
) -> EventMetrics:
    reference_index = 0
    predicted_index = 0
    matched = 0
    while reference_index < len(reference) and predicted_index < len(predicted):
        difference = predicted[predicted_index] - reference[reference_index]
        if abs(difference) <= tolerance_sec:
            matched += 1
            reference_index += 1
            predicted_index += 1
        elif difference < 0:
            predicted_index += 1
        else:
            reference_index += 1
    precision = matched / len(predicted) if predicted else 0.0
    recall = matched / len(reference) if reference else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0
        else 0.0
    )
    return EventMetrics(
        reference_count=len(reference),
        predicted_count=len(predicted),
        matched_count=matched,
        precision=precision,
        recall=recall,
        f1=f1,
    )


def periodic_events(
    phase_sec: float,
    period_sec: float,
    duration_sec: float,
) -> list[float]:
    if period_sec <= 0:
        raise ValueError("period_sec must be greater than zero")
    phase = phase_sec % period_sec
    count = max(0, math.ceil((duration_sec - phase) / period_sec))
    return [phase + index * period_sec for index in range(count)]


def reference_bpm(beat_times: list[float]) -> float:
    intervals = [
        current - previous
        for previous, current in zip(beat_times, beat_times[1:])
        if current > previous
    ]
    if not intervals:
        raise ValueError("positive beat intervals are required")
    return 60.0 / statistics.median(intervals)


def audio_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def annotation_path(annotations_root: Path, audio_path: Path) -> Path:
    identifier = audio_path.stem.replace(".", "_")
    return annotations_root / f"gtzan_{identifier}.beats"


def evaluate_track(
    audio_path: Path,
    annotations_root: Path,
) -> TrackResult:
    annotations = annotation_path(annotations_root, audio_path)
    beat_times, beat_labels = read_annotations(annotations)
    numerator = max(beat_labels)
    if numerator < 2:
        raise ValueError(f"{annotations}: unsupported meter labels")
    downbeat_times = [
        time_sec
        for time_sec, label in zip(beat_times, beat_labels)
        if label == 1
    ]
    duration_sec = audio_duration(audio_path)
    started = time.perf_counter()
    estimate = estimate_tempo(
        audio_path,
        numerator=numerator,
        denominator=4,
    )
    elapsed_sec = time.perf_counter() - started
    beat_period_sec = 60.0 / estimate.bpm
    predicted_beats = periodic_events(
        estimate.beat_offset_sec,
        beat_period_sec,
        duration_sec,
    )
    predicted_downbeats = periodic_events(
        estimate.beat_offset_sec,
        beat_period_sec * numerator,
        duration_sec,
    )
    expected_bpm = reference_bpm(beat_times)
    return TrackResult(
        track=audio_path.stem,
        genre=audio_path.parent.name,
        numerator=numerator,
        reference_bpm=expected_bpm,
        estimated_bpm=estimate.bpm,
        estimated_measure_offset_sec=estimate.beat_offset_sec,
        tempo_absolute_percent_error=(
            abs(estimate.bpm - expected_bpm) / expected_bpm * 100.0
        ),
        beat=match_events(beat_times, predicted_beats),
        downbeat=match_events(downbeat_times, predicted_downbeats),
        elapsed_sec=elapsed_sec,
    )


def aggregate_events(results: list[TrackResult], field: str) -> dict[str, float]:
    metrics = [getattr(result, field) for result in results]
    reference_count = sum(metric.reference_count for metric in metrics)
    predicted_count = sum(metric.predicted_count for metric in metrics)
    matched_count = sum(metric.matched_count for metric in metrics)
    precision = matched_count / predicted_count if predicted_count else 0.0
    recall = matched_count / reference_count if reference_count else 0.0
    micro_f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0
        else 0.0
    )
    return {
        "microPrecision": precision,
        "microRecall": recall,
        "microF1": micro_f1,
        "macroF1": statistics.mean(metric.f1 for metric in metrics),
    }


def summarize(results: list[TrackResult]) -> dict[str, object]:
    by_genre = defaultdict(list)
    for result in results:
        by_genre[result.genre].append(result)
    tempo_errors = [result.tempo_absolute_percent_error for result in results]
    return {
        "trackCount": len(results),
        "tempo": {
            "meanAbsolutePercentError": statistics.mean(tempo_errors),
            "medianAbsolutePercentError": statistics.median(tempo_errors),
            "accuracyWithin4Percent": sum(error <= 4.0 for error in tempo_errors)
            / len(tempo_errors),
        },
        "beat": aggregate_events(results, "beat"),
        "downbeat": aggregate_events(results, "downbeat"),
        "elapsedSec": sum(result.elapsed_sec for result in results),
        "genreDownbeatMacroF1": {
            genre: statistics.mean(result.downbeat.f1 for result in genre_results)
            for genre, genre_results in sorted(by_genre.items())
        },
    }


def select_split(
    audio_paths: list[Path],
    split: str,
) -> list[Path]:
    if split == "all":
        return audio_paths
    by_genre = defaultdict(list)
    for path in audio_paths:
        by_genre[path.parent.name].append(path)
    parity = 0 if split == "development" else 1
    return sorted(
        path
        for genre_paths in by_genre.values()
        for path in sorted(genre_paths)[parity::2]
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate constant-tempo beat and downbeat grids.",
    )
    parser.add_argument("--audio-root", type=Path, required=True)
    parser.add_argument("--annotations-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--split",
        choices=("all", "development", "evaluation"),
        default="all",
    )
    args = parser.parse_args()

    audio_paths = sorted(args.audio_root.rglob("*.wav"))
    audio_paths = select_split(audio_paths, args.split)
    if args.limit is not None:
        if args.limit <= 0:
            parser.error("--limit must be greater than zero")
        audio_paths = audio_paths[: args.limit]
    if not audio_paths:
        parser.error("no WAV files were found")

    results = []
    for index, audio_path in enumerate(audio_paths, start=1):
        result = evaluate_track(audio_path, args.annotations_root)
        results.append(result)
        print(
            f"[{index}/{len(audio_paths)}] {result.track}: "
            f"BPM={result.estimated_bpm:.1f}, "
            f"downbeat F1={result.downbeat.f1:.3f}",
            flush=True,
        )

    report = {
        "toleranceSec": MATCH_TOLERANCE_SEC,
        "summary": summarize(results),
        "tracks": [asdict(result) for result in results],
    }
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
