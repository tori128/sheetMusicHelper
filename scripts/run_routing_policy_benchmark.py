from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from scripts.compare_muscriptor_variants import (
        ResultNote,
        _crop_reference_notes,
        _reference_notes,
        _reference_score,
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
    from scripts.run_timing_guide_gain_benchmark import (
        PRODUCT_GAINS,
        _gain_arguments,
    )
except ModuleNotFoundError:
    from compare_muscriptor_variants import (
        ResultNote,
        _crop_reference_notes,
        _reference_notes,
        _reference_score,
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
    from run_timing_guide_gain_benchmark import (
        PRODUCT_GAINS,
        _gain_arguments,
    )


MATERIAL_F1_DELTA = 0.005


@dataclass(frozen=True, slots=True)
class Variant:
    id: str
    selection: str = "automatic"
    guide_scope: str = "all"
    reject_guide_events: bool = True
    expand_fixed_families: bool = True
    collapse_fixed_duplicates: bool = True


VARIANTS = (
    Variant("automaticNoGuide", guide_scope="none"),
    Variant(
        "automaticPitchedGuideNoRejection",
        guide_scope="pitched",
        reject_guide_events=False,
    ),
    Variant("automaticPitchedGuide", guide_scope="pitched"),
    Variant("automaticAllGuides"),
    Variant("fixedMetadataNoGuide", selection="metadata", guide_scope="none"),
    Variant(
        "fixedMetadataPitchedGuide",
        selection="metadata",
        guide_scope="pitched",
    ),
    Variant("fixedMetadataAllGuides", selection="metadata"),
    Variant(
        "fixedMetadataSelectedOnly",
        selection="metadata",
        expand_fixed_families=False,
    ),
    Variant(
        "fixedMetadataExpandedNoCollapse",
        selection="metadata",
        collapse_fixed_duplicates=False,
    ),
    Variant("fixedAnimePreset", selection="anime"),
)


def _boolean_argument(name: str, enabled: bool) -> str:
    return f"--{name}" if enabled else f"--no-{name}"


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


def _scored_condition(
    predicted: list[ResultNote],
    reference: list[ResultNote],
) -> dict[str, Any]:
    score_120 = _reference_score(
        predicted,
        reference,
        onset_tolerance_sec=0.12,
        match_instruments=True,
    )
    score_50 = _reference_score(
        predicted,
        reference,
        onset_tolerance_sec=0.05,
        match_instruments=True,
    )
    return {
        "referenceNotes": score_120["referenceNotes"],
        "predictedNotes": len(predicted),
        "matches": score_120["matches"],
        "precision": score_120["precision"],
        "recall": score_120["recall"],
        "f1": score_120["f1"],
        "score50Ms": {
            "matches": score_50["matches"],
            "precision": score_50["precision"],
            "recall": score_50["recall"],
            "f1": score_50["f1"],
        },
        "medianPredictionErrorMs": score_120["timing"][
            "medianPredictionErrorMs"
        ],
        "p95AbsoluteErrorMs": score_120["timing"]["p95AbsoluteErrorMs"],
        "crossInstrumentDuplicateGroups": 0,
    }


def _aggregate(cases: list[dict[str, Any]], key: str, variant: str) -> dict[str, Any]:
    return _aggregate_condition(
        [{"conditions": case[key]} for case in cases],
        variant,
    )


def _comparison(
    cases: list[dict[str, Any]],
    candidate: str,
    baseline: str,
    key: str,
) -> dict[str, Any]:
    candidate_result = _aggregate(cases, key, candidate)
    baseline_result = _aggregate(cases, key, baseline)
    delta = round(
        candidate_result["score50Ms"]["microF1"]
        - baseline_result["score50Ms"]["microF1"],
        4,
    )
    track_deltas = {
        case["trackId"]: round(
            case[key][candidate]["score50Ms"]["f1"]
            - case[key][baseline]["score50Ms"]["f1"],
            4,
        )
        for case in cases
    }
    return {
        "candidate": candidate,
        "baseline": baseline,
        "microF1Delta50Ms": delta,
        "classification": (
            "improved"
            if delta > MATERIAL_F1_DELTA
            else "degraded"
            if delta < -MATERIAL_F1_DELTA
            else "noMaterialChange"
        ),
        "trackWins": sum(value > MATERIAL_F1_DELTA for value in track_deltas.values()),
        "trackTies": sum(
            abs(value) <= MATERIAL_F1_DELTA for value in track_deltas.values()
        ),
        "trackLosses": sum(value < -MATERIAL_F1_DELTA for value in track_deltas.values()),
        "trackF1Deltas50Ms": track_deltas,
    }


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Compare source-separated transcription policies."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=repository / "scripts" / "benchmark_cases" / "babyslakh_v2.json",
    )
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--stem-model", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--backend", choices=("Auto", "CPU", "CUDA"), default="CUDA")
    parser.add_argument("--dtype", choices=("float16", "float32"), default="float16")
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--timeout-sec", type=int, default=1200)
    parser.add_argument("--reuse-results", action="store_true")
    args = parser.parse_args()

    manifest = _read_json(args.manifest.resolve())
    dataset_root = args.dataset_root.resolve()
    model = args.model.resolve()
    stem_model = args.stem_model.resolve()
    work_dir = args.work_dir.resolve()
    cache_root = (
        args.cache_root.resolve()
        if args.cache_root is not None
        else work_dir / "user-data"
    )
    if not model.is_file():
        raise FileNotFoundError(model)
    if not stem_model.exists():
        raise FileNotFoundError(stem_model)

    cases: list[dict[str, Any]] = []
    for case_index, segment in enumerate(manifest["segments"], start=1):
        track_id = segment["trackId"]
        track_directory = dataset_root / track_id
        audio = track_directory / "mix.wav"
        reference_midi = track_directory / "all_src.mid"
        if not audio.is_file() or not reference_midi.is_file():
            raise FileNotFoundError(f"BabySlakh track is incomplete: {track_directory}")

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
            "--backend",
            args.backend,
            "--dtype",
            args.dtype,
            "--mode",
            "separated",
            "--start",
            str(segment["startSec"]),
            "--duration",
            str(segment["durationSec"]),
            "--user-data",
            str(cache_root / track_id),
            "--drum-onset-guide",
        ] + _gain_arguments(PRODUCT_GAINS)
        if args.ffmpeg is not None:
            common.extend(("--ffmpeg", str(args.ffmpeg.resolve())))

        pitch_conditions: dict[str, dict[str, Any]] = {}
        instrument_conditions: dict[str, dict[str, Any]] = {}
        runtimes: dict[str, float] = {}
        rotated = VARIANTS[case_index - 1 :] + VARIANTS[: case_index - 1]
        for variant in rotated:
            print(
                f"[{case_index}/{len(manifest['segments'])}] "
                f"{track_id}: {variant.id}",
                flush=True,
            )
            selection_arguments = (
                ["--automatic-instruments"]
                if variant.selection == "automatic"
                else ["--all-preset-tracks"]
                if variant.selection == "anime"
                else ["--instruments", *segment["fixedInstruments"]]
            )
            output_path = work_dir / "raw" / f"{track_id}-{variant.id}.json"
            raw = _run_score(
                repository=repository,
                output_path=output_path,
                command=common
                + selection_arguments
                + [
                    "--timing-guide-scope",
                    variant.guide_scope,
                    _boolean_argument(
                        "timing-guide-note-filter",
                        variant.guide_scope != "none",
                    ),
                    _boolean_argument(
                        "guide-instrument-rejection", variant.reject_guide_events
                    ),
                    _boolean_argument(
                        "fixed-family-expansion", variant.expand_fixed_families
                    ),
                    _boolean_argument(
                        "fixed-family-duplicate-collapse",
                        variant.collapse_fixed_duplicates,
                    ),
                    "--output-json",
                    str(output_path),
                ],
                timeout_sec=args.timeout_sec,
                reuse_results=args.reuse_results,
            )
            pitch_conditions[variant.id] = _condition_result(raw)
            instrument_conditions[variant.id] = _scored_condition(
                _notes(raw["outputNotes"]), reference
            )
            runtimes[variant.id] = raw["elapsedSec"]

        cases.append(
            {
                "trackId": track_id,
                "startSec": segment["startSec"],
                "durationSec": segment["durationSec"],
                "fixedInstruments": segment["fixedInstruments"],
                "conditions": pitch_conditions,
                "instrumentConditions": instrument_conditions,
                "runtimeSec": runtimes,
            }
        )

    variant_ids = tuple(variant.id for variant in VARIANTS)
    comparisons = {
        "pitchedGuideWithoutRejection": (
            "automaticPitchedGuideNoRejection",
            "automaticNoGuide",
        ),
        "pitchedGuideWithRejection": (
            "automaticPitchedGuide",
            "automaticNoGuide",
        ),
        "drumInputGuideContribution": (
            "automaticAllGuides",
            "automaticPitchedGuide",
        ),
        "automaticVersusMetadataFixed": (
            "automaticAllGuides",
            "fixedMetadataAllGuides",
        ),
        "fixedPitchedGuideContribution": (
            "fixedMetadataPitchedGuide",
            "fixedMetadataNoGuide",
        ),
        "fixedDrumInputGuideContribution": (
            "fixedMetadataAllGuides",
            "fixedMetadataPitchedGuide",
        ),
        "fixedFamilyMethods": (
            "fixedMetadataAllGuides",
            "fixedMetadataSelectedOnly",
        ),
        "fixedDuplicateCollapse": (
            "fixedMetadataAllGuides",
            "fixedMetadataExpandedNoCollapse",
        ),
        "metadataFixedVersusAnimePreset": (
            "fixedMetadataAllGuides",
            "fixedAnimePreset",
        ),
    }
    summary = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(UTC).isoformat(timespec="seconds"),
        "sourceRevision": _git_revision(repository),
        "sourceWorkingTreeModified": _git_worktree_modified(repository),
        "dataset": manifest["dataset"],
        "evaluation": {
            "segments": len(cases),
            "totalAudioSec": round(sum(case["durationSec"] for case in cases), 3),
            "primaryOnsetToleranceMs": 50,
            "secondaryOnsetToleranceMs": 120,
            "pitchOnlyIncludesUnsupportedPrograms": True,
            "instrumentAwareExcludesUnsupportedPrograms": True,
            "offsets": "not scored",
            "materialMicroF1Delta": MATERIAL_F1_DELTA,
        },
        "configuration": {
            "transcriptionModel": model.parent.name,
            "backend": args.backend,
            "dtype": args.dtype,
            "timingGuideGains": PRODUCT_GAINS,
            "timingGuideNoteFilterByGuideScope": {
                "none": False,
                "pitched": True,
                "all": True,
            },
        },
        "environment": {
            "gpu": _gpu_summary(),
            "python": sys.version.split()[0],
        },
        "variants": {variant.id: asdict(variant) for variant in VARIANTS},
        "aggregate": {
            "pitchOnly": {
                variant: _aggregate(cases, "conditions", variant)
                for variant in variant_ids
            },
            "instrumentAware": {
                variant: _aggregate(cases, "instrumentConditions", variant)
                for variant in variant_ids
            },
        },
        "comparisons": {
            name: {
                "pitchOnly": _comparison(cases, candidate, baseline, "conditions"),
                "instrumentAware": _comparison(
                    cases, candidate, baseline, "instrumentConditions"
                ),
            }
            for name, (candidate, baseline) in comparisons.items()
        },
        "runtime": {
            variant: {
                "medianSec": round(
                    statistics.median(case["runtimeSec"][variant] for case in cases),
                    3,
                ),
                "totalSec": round(
                    sum(case["runtimeSec"][variant] for case in cases), 3
                ),
            }
            for variant in variant_ids
        },
        "cases": cases,
    }
    rendered = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
