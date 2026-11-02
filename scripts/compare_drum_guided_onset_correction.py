from __future__ import annotations

import argparse
import json
import random
from collections import defaultdict
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal

try:
    from scripts.compare_muscriptor_variants import (
        ResultNote,
        _crop_reference_notes,
        _notation_score,
        _reference_notes,
        _reference_score,
        _timing_and_mismatch_score,
    )
except ModuleNotFoundError:
    from compare_muscriptor_variants import (
        ResultNote,
        _crop_reference_notes,
        _notation_score,
        _reference_notes,
        _reference_score,
        _timing_and_mismatch_score,
    )

from earcopy_service.instrument_routing import (
    BASS_INSTRUMENT_IDS,
    GUITAR_INSTRUMENT_IDS,
    PIANO_INSTRUMENT_IDS,
)


Split = Literal["design", "holdout", "all"]


@dataclass(frozen=True, slots=True)
class Segment:
    track_id: str
    split: Literal["design", "holdout"]
    start_sec: float
    duration_sec: float


def _load_notes(path: Path) -> list[ResultNote]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [
        ResultNote(
            instrument=str(note["instrument"]),
            pitch=int(note["pitch"]),
            start_sec=float(note["startSec"]),
            end_sec=float(note["endSec"]),
        )
        for note in payload["notes"]
    ]


def _input_name(instrument: str) -> str:
    if instrument == "drums":
        return "drums"
    if instrument in BASS_INSTRUMENT_IDS:
        return "bass"
    if instrument in PIANO_INSTRUMENT_IDS:
        return "piano"
    if instrument in GUITAR_INSTRUMENT_IDS:
        return "guitar"
    if instrument == "voice":
        return "vocals"
    return "other"


def _ordered_note_matches(
    baseline: list[ResultNote],
    guided: list[ResultNote],
    maximum_difference_sec: float,
) -> list[tuple[int, int]]:
    """Maximize ordered matches, then minimize their total onset difference."""

    baseline_count = len(baseline)
    guided_count = len(guided)
    scores = [
        [(0, 0.0) for _ in range(guided_count + 1)]
        for _ in range(baseline_count + 1)
    ]
    actions = [
        ["" for _ in range(guided_count + 1)]
        for _ in range(baseline_count + 1)
    ]

    def better(
        candidate: tuple[int, float, str],
        incumbent: tuple[int, float, str],
    ) -> bool:
        if candidate[0] != incumbent[0]:
            return candidate[0] > incumbent[0]
        if abs(candidate[1] - incumbent[1]) > 1e-12:
            return candidate[1] < incumbent[1]
        return {"match": 0, "skip-baseline": 1, "skip-guided": 2}[
            candidate[2]
        ] < {"match": 0, "skip-baseline": 1, "skip-guided": 2}[
            incumbent[2]
        ]

    for baseline_index in range(1, baseline_count + 1):
        actions[baseline_index][0] = "skip-baseline"
    for guided_index in range(1, guided_count + 1):
        actions[0][guided_index] = "skip-guided"

    for baseline_index in range(1, baseline_count + 1):
        for guided_index in range(1, guided_count + 1):
            skip_baseline = scores[baseline_index - 1][guided_index]
            best = (skip_baseline[0], skip_baseline[1], "skip-baseline")
            skip_guided = scores[baseline_index][guided_index - 1]
            candidate = (skip_guided[0], skip_guided[1], "skip-guided")
            if better(candidate, best):
                best = candidate

            difference_sec = abs(
                baseline[baseline_index - 1].start_sec
                - guided[guided_index - 1].start_sec
            )
            if difference_sec <= maximum_difference_sec:
                previous = scores[baseline_index - 1][guided_index - 1]
                candidate = (
                    previous[0] + 1,
                    previous[1] + difference_sec,
                    "match",
                )
                if better(candidate, best):
                    best = candidate
            scores[baseline_index][guided_index] = (best[0], best[1])
            actions[baseline_index][guided_index] = best[2]

    matches: list[tuple[int, int]] = []
    baseline_index = baseline_count
    guided_index = guided_count
    while baseline_index > 0 or guided_index > 0:
        action = actions[baseline_index][guided_index]
        if action == "match":
            matches.append((baseline_index - 1, guided_index - 1))
            baseline_index -= 1
            guided_index -= 1
        elif action == "skip-baseline":
            baseline_index -= 1
        else:
            guided_index -= 1
    matches.reverse()
    return matches


def correct_onsets(
    drumless: list[ResultNote],
    guided: list[ResultNote],
    maximum_difference_sec: float,
) -> tuple[list[ResultNote], dict[str, Any]]:
    baseline_groups: dict[tuple[str, int], list[tuple[int, ResultNote]]] = (
        defaultdict(list)
    )
    guided_groups: dict[tuple[str, int], list[ResultNote]] = defaultdict(list)
    for index, note in enumerate(drumless):
        if note.instrument != "drums":
            baseline_groups[(_input_name(note.instrument), note.pitch)].append(
                (index, note)
            )
    for note in guided:
        if note.instrument != "drums":
            guided_groups[(_input_name(note.instrument), note.pitch)].append(note)

    corrected = list(drumless)
    differences_sec: list[float] = []
    corrected_by_input: dict[str, int] = defaultdict(int)
    for key in sorted(baseline_groups.keys() & guided_groups.keys()):
        baseline_group = sorted(
            baseline_groups[key], key=lambda item: item[1].start_sec
        )
        guided_group = sorted(
            guided_groups[key], key=lambda note: note.start_sec
        )
        matches = _ordered_note_matches(
            [note for _, note in baseline_group],
            guided_group,
            maximum_difference_sec,
        )
        for baseline_group_index, guided_group_index in matches:
            note_index, baseline_note = baseline_group[baseline_group_index]
            guided_note = guided_group[guided_group_index]
            difference_sec = guided_note.start_sec - baseline_note.start_sec
            corrected[note_index] = replace(
                baseline_note,
                start_sec=guided_note.start_sec,
                end_sec=baseline_note.end_sec + difference_sec,
            )
            differences_sec.append(difference_sec)
            corrected_by_input[key[0]] += 1

    absolute_differences = sorted(abs(value) for value in differences_sec)
    return corrected, {
        "correctedNotes": len(differences_sec),
        "correctedByInput": dict(sorted(corrected_by_input.items())),
        "meanAbsoluteCorrectionMs": (
            round(sum(absolute_differences) / len(absolute_differences) * 1000, 2)
            if absolute_differences
            else None
        ),
        "maximumAbsoluteCorrectionMs": (
            round(absolute_differences[-1] * 1000, 2)
            if absolute_differences
            else None
        ),
    }


def _case_metrics(
    predicted: list[ResultNote],
    reference: list[ResultNote],
) -> dict[str, Any]:
    return {
        "onset50": _reference_score(
            predicted,
            reference,
            onset_tolerance_sec=0.05,
            match_instruments=False,
        ),
        "onset120": _reference_score(
            predicted,
            reference,
            onset_tolerance_sec=0.12,
            match_instruments=False,
        ),
        "weightedOnset": _timing_and_mismatch_score(
            predicted,
            reference,
            onset_tolerance_sec=0.12,
            timing_penalty_sec=0.05,
            match_instruments=False,
        ),
        "onsetOffset50": _notation_score(
            predicted,
            reference,
            onset_tolerance_sec=0.05,
            require_offset=True,
            match_instruments=False,
        ),
    }


def _aggregate(cases: list[dict[str, Any]]) -> dict[str, Any]:
    reference_notes = sum(item["onset50"]["referenceNotes"] for item in cases)
    predicted_notes = sum(item["onset50"]["predictedNotes"] for item in cases)
    denominator = reference_notes + predicted_notes

    def aggregate_matches(metric: str) -> dict[str, int | float]:
        matches = sum(item[metric]["matches"] for item in cases)
        return {
            "matches": matches,
            "precision": round(matches / predicted_notes, 4) if predicted_notes else 0.0,
            "recall": round(matches / reference_notes, 4) if reference_notes else 0.0,
            "f1": round(2 * matches / denominator, 4) if denominator else 0.0,
        }

    timing_credit = sum(
        float(item["weightedOnset"]["timingCredit"]) for item in cases
    )
    return {
        "segments": len(cases),
        "referenceNotes": reference_notes,
        "predictedNotes": predicted_notes,
        "onset50": aggregate_matches("onset50"),
        "onset120": aggregate_matches("onset120"),
        "weightedOnset": {
            "matches": sum(item["weightedOnset"]["matches"] for item in cases),
            "timingCredit": round(timing_credit, 6),
            "score": round(2 * timing_credit / denominator, 4) if denominator else 0.0,
        },
        "onsetOffset50": aggregate_matches("onsetOffset50"),
    }


def _segments(path: Path) -> list[Segment]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [
        Segment(
            track_id=str(item["trackId"]),
            split=item["split"],
            start_sec=float(item["startSec"]),
            duration_sec=float(item["durationSec"]),
        )
        for item in payload["segments"]
    ]


def _metric_value(result: dict[str, Any], metric: str) -> float:
    section, field = metric.split(".")
    return float(result[section][field])


def _bootstrap_differences(
    candidate_cases: list[dict[str, Any]],
    current_cases: list[dict[str, Any]],
    *,
    iterations: int = 10_000,
    seed: int = 20260818,
) -> dict[str, Any]:
    if len(candidate_cases) != len(current_cases):
        raise ValueError("candidate and current case counts must match")
    if not candidate_cases:
        raise ValueError("bootstrap requires at least one case")
    metrics = (
        "onset50.f1",
        "onset120.f1",
        "weightedOnset.score",
        "onsetOffset50.f1",
    )
    differences = {metric: [] for metric in metrics}
    random_generator = random.Random(seed)
    for _ in range(iterations):
        indices = [
            random_generator.randrange(len(candidate_cases))
            for _ in range(len(candidate_cases))
        ]
        candidate = _aggregate([candidate_cases[index] for index in indices])
        current = _aggregate([current_cases[index] for index in indices])
        for metric in metrics:
            differences[metric].append(
                _metric_value(candidate, metric) - _metric_value(current, metric)
            )

    def percentile(values: list[float], proportion: float) -> float:
        ordered = sorted(values)
        index = round((len(ordered) - 1) * proportion)
        return ordered[index]

    return {
        "iterations": iterations,
        "seed": seed,
        "samplingUnit": "track segment",
        "differences": {
            metric: {
                "candidateMinusCurrent": round(
                    _metric_value(_aggregate(candidate_cases), metric)
                    - _metric_value(_aggregate(current_cases), metric),
                    4,
                ),
                "confidenceInterval95": [
                    round(percentile(values, 0.025), 4),
                    round(percentile(values, 0.975), 4),
                ],
                "proportionAboveZero": round(
                    sum(value > 0.0 for value in values) / len(values),
                    4,
                ),
            }
            for metric, values in differences.items()
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--drumless-results", type=Path, required=True)
    parser.add_argument("--guided-results", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument(
        "--maximum-difference-ms",
        nargs="+",
        type=int,
        default=(20, 30, 50, 80, 120, 180, 250),
    )
    args = parser.parse_args()

    segments = _segments(args.manifest)
    conditions: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    per_segment: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    correction_statistics: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"correctedNotes": 0, "correctedByInput": defaultdict(int)}
    )
    for segment in segments:
        reference = _crop_reference_notes(
            _reference_notes(
                args.dataset_root / segment.track_id / "all_src.mid"
            ),
            segment.start_sec,
            segment.duration_sec,
        )
        drumless = _load_notes(
            args.drumless_results / f"{segment.track_id}-drumless.json"
        )
        current = _load_notes(
            args.guided_results / f"{segment.track_id}-enabled.json"
        )
        condition_notes: dict[str, list[ResultNote]] = {
            "current": current,
            "drumless": drumless,
        }
        for maximum_difference_ms in args.maximum_difference_ms:
            name = f"corrected-{maximum_difference_ms}ms"
            candidate, statistics = correct_onsets(
                drumless,
                current,
                maximum_difference_ms / 1000,
            )
            condition_notes[name] = candidate
            accumulated = correction_statistics[name]
            accumulated["correctedNotes"] += statistics["correctedNotes"]
            for input_name, count in statistics["correctedByInput"].items():
                accumulated["correctedByInput"][input_name] += count
        for name, notes in condition_notes.items():
            metrics = _case_metrics(notes, reference)
            conditions[name][segment.split].append(metrics)
            conditions[name]["all"].append(metrics)
            per_segment[name][segment.track_id] = {
                "split": segment.split,
                **_aggregate([metrics]),
            }

    aggregated = {
        name: {
            split: _aggregate(cases)
            for split, cases in split_cases.items()
        }
        for name, split_cases in conditions.items()
    }
    candidates = [
        name for name in aggregated if name.startswith("corrected-")
    ]
    selected = max(
        candidates,
        key=lambda name: (
            aggregated[name]["design"]["weightedOnset"]["score"],
            aggregated[name]["design"]["onset50"]["f1"],
            aggregated[name]["design"]["onsetOffset50"]["f1"],
            -int(name.removeprefix("corrected-").removesuffix("ms")),
        ),
    )
    output = {
        "method": {
            "baseline": "transcription without drum onset guide",
            "timingReference": "current transcription with 20 percent drum onset guide",
            "matching": "maximum one-to-one ordered matches by transcription input and exact MIDI pitch",
            "duration": "preserved from the transcription without drum onset guide",
            "parameterSelection": "highest weighted onset F1 on design split; onset F1 at 50 ms and onset-offset F1 as tie breakers",
        },
        "maximumDifferenceMs": args.maximum_difference_ms,
        "selectedCondition": selected,
        "results": aggregated,
        "selectedPerSegment": {
            name: per_segment[name]
            for name in ("current", "drumless", selected)
        },
        "holdoutBootstrap": _bootstrap_differences(
            conditions[selected]["holdout"],
            conditions["current"]["holdout"],
        ),
        "correctionStatistics": {
            name: {
                "correctedNotes": value["correctedNotes"],
                "correctedByInput": dict(sorted(value["correctedByInput"].items())),
            }
            for name, value in correction_statistics.items()
        },
    }
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
