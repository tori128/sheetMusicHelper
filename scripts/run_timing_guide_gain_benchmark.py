from __future__ import annotations

import argparse
import json
import platform
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from earcopy_service.transcription_inputs import (
    DEFAULT_PITCHED_TIMING_GUIDE_GAINS,
)

try:
    from scripts.compare_muscriptor_variants import (
        PROGRAM_INSTRUMENTS,
        ResultNote,
        _aggregate_timing_and_mismatch,
        _crop_reference_notes,
        _reference_notes,
        _reference_score,
        _timing_and_mismatch_score,
    )
    from scripts.run_public_transcription_benchmark import (
        _aggregate_condition,
        _condition_result,
        _git_revision,
        _git_worktree_modified,
        _gpu_summary,
        _read_json,
        _run_score,
    )
except ModuleNotFoundError:
    from compare_muscriptor_variants import (
        PROGRAM_INSTRUMENTS,
        ResultNote,
        _aggregate_timing_and_mismatch,
        _crop_reference_notes,
        _reference_notes,
        _reference_score,
        _timing_and_mismatch_score,
    )
    from run_public_transcription_benchmark import (
        _aggregate_condition,
        _condition_result,
        _git_revision,
        _git_worktree_modified,
        _gpu_summary,
        _read_json,
        _run_score,
    )


GAINS = (0.0, 0.1, 0.2, 0.3)
PRODUCT_GAINS = dict(DEFAULT_PITCHED_TIMING_GUIDE_GAINS)
_PRODUCT_GAIN_VALUES = set(PRODUCT_GAINS.values())
PRODUCT_VARIANT_ID = (
    f"all-g{round(next(iter(_PRODUCT_GAIN_VALUES)) * 100)}"
    if len(_PRODUCT_GAIN_VALUES) == 1
    else "product-gains"
)
TARGET_FAMILIES = {
    "bass": frozenset({"acoustic_bass", "electric_bass", "contrabass"}),
    "piano": frozenset({"acoustic_piano", "electric_piano"}),
    "guitar": frozenset(
        {
            "acoustic_guitar",
            "clean_electric_guitar",
            "distorted_electric_guitar",
        }
    ),
    "vocals": frozenset({"voice"}),
    "other": frozenset(PROGRAM_INSTRUMENTS.values())
    - frozenset(
        {
            "drums",
            "voice",
            "acoustic_bass",
            "electric_bass",
            "contrabass",
            "acoustic_piano",
            "electric_piano",
            "acoustic_guitar",
            "clean_electric_guitar",
            "distorted_electric_guitar",
        }
    ),
}
PITCHED_TARGET_FAMILY = frozenset().union(*TARGET_FAMILIES.values())


@dataclass(frozen=True, slots=True)
class Variant:
    target: str
    gain: float

    @property
    def id(self) -> str:
        return f"{self.target}-g{round(self.gain * 100)}"

    @property
    def gains(self) -> dict[str, float]:
        values = dict(PRODUCT_GAINS)
        values[self.target] = self.gain
        return values

    @property
    def raw_result_id(self) -> str:
        return PRODUCT_VARIANT_ID if self.gains == PRODUCT_GAINS else self.id


def _notes(rows: list[dict[str, Any]]) -> list[ResultNote]:
    return [
        ResultNote(
            instrument=str(row["instrument"]),
            pitch=int(row["pitch"]),
            start_sec=float(row["startSec"]),
            end_sec=float(row["endSec"]),
        )
        for row in rows
    ]


def _family_condition(
    predicted: list[ResultNote],
    reference: list[ResultNote],
    family: frozenset[str],
) -> dict[str, Any]:
    predicted_family = [note for note in predicted if note.instrument in family]
    reference_family = [note for note in reference if note.instrument in family]
    scores = {
        tolerance_ms: _reference_score(
            predicted_family,
            reference_family,
            onset_tolerance_sec=tolerance_ms / 1000,
            match_instruments=False,
        )
        for tolerance_ms in (20, 50, 120)
    }
    return {
        "referenceNotes": len(reference_family),
        "predictedNotes": len(predicted_family),
        "score20Ms": scores[20],
        "score50Ms": scores[50],
        "score120Ms": scores[120],
        "timingAndMismatchScore": _timing_and_mismatch_score(
            predicted_family,
            reference_family,
            onset_tolerance_sec=0.12,
            match_instruments=False,
        ),
    }


def _micro_aggregate(results: list[dict[str, Any]]) -> dict[str, Any]:
    reference_notes = sum(item["referenceNotes"] for item in results)
    predicted_notes = sum(item["predictedNotes"] for item in results)

    def score(tolerance: str) -> dict[str, int | float]:
        matches = sum(item[tolerance]["matches"] for item in results)
        false_positives = predicted_notes - matches
        false_negatives = reference_notes - matches
        precision = matches / predicted_notes if predicted_notes else 0.0
        recall = matches / reference_notes if reference_notes else 0.0
        f1_denominator = 2 * matches + false_positives + false_negatives
        f1 = (
            2 * matches / f1_denominator
            if f1_denominator
            else 0.0
        )
        return {
            "matches": matches,
            "falsePositiveNotes": false_positives,
            "falseNegativeNotes": false_negatives,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "microF1": round(f1, 4),
        }

    return {
        "referenceNotes": reference_notes,
        "predictedNotes": predicted_notes,
        "score20Ms": score("score20Ms"),
        "score50Ms": score("score50Ms"),
        "score120Ms": score("score120Ms"),
        "timingAndMismatchScore": _aggregate_timing_and_mismatch(results),
    }


def _gain_arguments(gains: dict[str, float]) -> list[str]:
    return [
        "--timing-guide-gain-bass",
        str(gains["bass"]),
        "--timing-guide-gain-piano",
        str(gains["piano"]),
        "--timing-guide-gain-guitar",
        str(gains["guitar"]),
        "--timing-guide-gain-vocals",
        str(gains["vocals"]),
        "--timing-guide-gain-other",
        str(gains["other"]),
    ]


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Measure per-part drum timing-guide gains on BabySlakh."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=repository
        / "scripts"
        / "benchmark_cases"
        / "babyslakh_v2.json",
    )
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--stem-model", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--timeout-sec", type=int, default=1200)
    parser.add_argument("--reuse-results", action="store_true")
    parser.add_argument(
        "--raw-prefix",
        default="",
        help="Prefix for raw result filenames when measurement settings change.",
    )
    parser.add_argument(
        "--targets",
        nargs="+",
        choices=tuple(TARGET_FAMILIES),
        default=list(TARGET_FAMILIES),
        help="Part families to evaluate. Defaults to every family.",
    )
    parser.add_argument(
        "--gains",
        nargs="+",
        type=float,
        default=list(GAINS),
        help="Drum mix gains to evaluate. Defaults to 0.0 0.1 0.2 0.3.",
    )
    parser.add_argument(
        "--skip-product",
        action="store_true",
        help="Skip the combined product-gain condition.",
    )
    args = parser.parse_args()

    allowed_raw_prefix_characters = (
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
    )
    if any(
        character not in allowed_raw_prefix_characters
        for character in args.raw_prefix
    ):
        parser.error("--raw-prefix may contain only letters, numbers, '-' and '_'")

    targets = tuple(dict.fromkeys(args.targets))
    gains = tuple(sorted(set(args.gains)))
    if not gains or any(gain < 0.0 or gain > 1.0 for gain in gains):
        parser.error("--gains must contain values from 0.0 through 1.0")

    manifest = _read_json(args.manifest.resolve())
    dataset_root = args.dataset_root.resolve()
    model = args.model.resolve()
    stem_model = args.stem_model.resolve()
    work_dir = args.work_dir.resolve()
    if not model.is_file():
        raise FileNotFoundError(model)
    if not stem_model.exists():
        raise FileNotFoundError(stem_model)

    variants = [
        Variant(target, gain)
        for target in targets
        for gain in gains
    ]
    cases: list[dict[str, Any]] = []
    segment_count = len(manifest["segments"])
    for case_index, segment in enumerate(manifest["segments"], start=1):
        track_id = segment["trackId"]
        track_directory = dataset_root / track_id
        audio = track_directory / "mix.wav"
        reference_midi = track_directory / "all_src.mid"
        if not audio.is_file() or not reference_midi.is_file():
            raise FileNotFoundError(
                f"BabySlakh track is incomplete: {track_directory}"
            )
        reference = _crop_reference_notes(
            _reference_notes(reference_midi),
            start_sec=float(segment["startSec"]),
            duration_sec=float(segment["durationSec"]),
        )
        common = [
            sys.executable,
            str(repository / "scripts" / "score_transcription_job.py"),
            "--audio",
            str(audio),
            "--model",
            str(model),
            "--stem-model",
            str(stem_model),
            "--reference-midi",
            str(reference_midi),
            "--ignore-instruments",
            "--automatic-instruments",
            "--backend",
            "CUDA",
            "--dtype",
            "float16",
            "--mode",
            "separated",
            "--start",
            str(segment["startSec"]),
            "--duration",
            str(segment["durationSec"]),
            "--user-data",
            str(work_dir / "user-data" / track_id),
            "--drum-onset-guide",
            "--timing-guide-scope",
            "pitched",
            "--guide-instrument-rejection",
            "--timing-guide-note-filter",
        ]
        if args.ffmpeg is not None:
            common.extend(("--ffmpeg", str(args.ffmpeg.resolve())))

        raw_by_id: dict[str, dict[str, Any]] = {}
        product_result_required = (
            not args.skip_product
            or any(
                variant.raw_result_id == PRODUCT_VARIANT_ID
                for variant in variants
            )
        )
        ordered_variants = (
            [(PRODUCT_VARIANT_ID, PRODUCT_GAINS)]
            if product_result_required
            else []
        )
        ordered_variants.extend(
            (variant.id, variant.gains)
            for variant in variants
            if variant.raw_result_id != PRODUCT_VARIANT_ID
        )
        for variant_index, (variant_id, variant_gains) in enumerate(
            ordered_variants, start=1
        ):
            print(
                f"[{case_index}/{segment_count}] {track_id} "
                f"[{variant_index}/{len(ordered_variants)}] {variant_id}",
                flush=True,
            )
            output_path = (
                work_dir
                / "raw"
                / f"{track_id}-{args.raw_prefix}{variant_id}.json"
            )
            raw_by_id[variant_id] = _run_score(
                repository=repository,
                output_path=output_path,
                command=common
                + _gain_arguments(variant_gains)
                + ["--output-json", str(output_path)],
                timeout_sec=args.timeout_sec,
                reuse_results=args.reuse_results,
            )

        family_conditions: dict[str, dict[str, Any]] = {}
        overall_conditions: dict[str, dict[str, Any]] = {}
        runtimes: dict[str, float] = {}
        for target in targets:
            family = TARGET_FAMILIES[target]
            for gain in gains:
                variant = Variant(target, gain)
                condition_id = variant.id
                raw = raw_by_id[variant.raw_result_id]
                predicted = _notes(raw["notes"])
                family_conditions[condition_id] = _family_condition(
                    predicted,
                    reference,
                    family,
                )
                overall_conditions[condition_id] = _condition_result(raw)
                runtimes[condition_id] = float(raw["elapsedSec"])
        if not args.skip_product:
            product_raw = raw_by_id[PRODUCT_VARIANT_ID]
            overall_conditions["product"] = _condition_result(product_raw)
            product_pitched_condition = _family_condition(
                _notes(product_raw["notes"]),
                reference,
                PITCHED_TARGET_FAMILY,
            )
            runtimes["product"] = float(product_raw["elapsedSec"])
        else:
            product_pitched_condition = None
        cases.append(
            {
                "trackId": track_id,
                "familyConditions": family_conditions,
                "overallConditions": overall_conditions,
                "productPitchedCondition": product_pitched_condition,
                "runtimeSec": runtimes,
            }
        )

    aggregate: dict[str, dict[str, Any]] = {}
    selected_gains: dict[str, float] = {}
    for target in targets:
        by_gain: dict[str, Any] = {}
        for gain in gains:
            condition_id = f"{target}-g{round(gain * 100)}"
            by_gain[str(gain)] = _micro_aggregate(
                [case["familyConditions"][condition_id] for case in cases]
            )
        selected_gains[target] = min(
            (float(gain) for gain in by_gain),
            key=lambda gain: (
                -by_gain[str(gain)]["timingAndMismatchScore"]["score"],
                gain,
            ),
        )
        aggregate[target] = by_gain

    result = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(UTC).isoformat(timespec="seconds"),
        "sourceRevision": _git_revision(repository),
        "sourceWorkingTreeModified": _git_worktree_modified(repository),
        "dataset": manifest["dataset"],
        "evaluation": {
            "segments": len(cases),
            "totalAudioSec": sum(
                float(segment["durationSec"])
                for segment in manifest["segments"]
            ),
            "targets": list(targets),
            "gains": list(gains),
            "reportedOnsetTolerancesMs": [20, 50, 120],
            "offsets": "not scored",
            "selectionRule": (
                "highest timing-and-mismatch score over exact-pitch matches "
                "within 120 ms; choose the lower gain only when scores are equal"
            ),
        },
        "configuration": {
            "transcriptionModel": model.parent.name,
            "backend": "CUDA",
            "dtype": "float16",
            "instrumentSelection": "automatic",
            "discardDrumEvents": True,
            "timingGuideNoteFilter": True,
        },
        "environment": {
            "gpu": _gpu_summary(),
            "python": platform.python_version(),
        },
        "publicDataSelectedGains": selected_gains,
        "aggregate": aggregate,
        "cases": cases,
    }
    if not args.skip_product:
        result.update(
            {
                "productGains": PRODUCT_GAINS,
                "productSelectionRule": (
                    "prioritize onset placement and recall for notation"
                ),
                "productAggregate": _aggregate_condition(
                    [
                        {"conditions": case["overallConditions"]}
                        for case in cases
                    ],
                    "product",
                ),
                "productPitchedAggregate": _micro_aggregate(
                    [
                        case["productPitchedCondition"]
                        for case in cases
                    ]
                ),
            }
        )
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "publicDataSelectedGains": selected_gains,
                "productGains": PRODUCT_GAINS,
            },
            indent=2,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
