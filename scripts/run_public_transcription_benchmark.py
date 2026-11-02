from __future__ import annotations

import argparse
import json
import platform
import shutil
import statistics
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from scripts.compare_muscriptor_variants import (
        ResultNote,
        _aggregate_timing_and_mismatch,
        _crop_reference_notes,
        _reference_notes,
        _timing_and_mismatch_score,
    )
except ModuleNotFoundError:
    from compare_muscriptor_variants import (
        ResultNote,
        _aggregate_timing_and_mismatch,
        _crop_reference_notes,
        _reference_notes,
        _timing_and_mismatch_score,
    )


CONDITION_DIRECT = "direct"
CONDITION_SEPARATED_ROUTED = "separatedRouted"
CONDITION_SEPARATED_ROUTED_GUIDED_NO_NOTE_FILTER = (
    "separatedRoutedGuidedNoNoteFilter"
)
CONDITION_SEPARATED_ROUTED_GUIDED = "separatedRoutedGuided"


def _separated_condition_arguments(
    *,
    drum_onset_guide: bool,
    timing_guide_note_filter: bool,
) -> list[str]:
    arguments = [
        "--mode",
        "separated",
        (
            "--drum-onset-guide"
            if drum_onset_guide
            else "--no-drum-onset-guide"
        ),
        "--timing-guide-scope",
        "pitched",
        "--guide-instrument-rejection",
    ]
    arguments.append(
        "--timing-guide-note-filter"
        if timing_guide_note_filter
        else "--no-timing-guide-note-filter"
    )
    return arguments


def _rounded_ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def _condition_result(
    result: dict[str, Any],
    reference: list[ResultNote] | None = None,
) -> dict[str, Any]:
    score = result["score"]
    if score is None:
        raise ValueError("Benchmark result does not contain score")
    tolerance_scores = result["scoresByOnsetToleranceMs"]
    if tolerance_scores is None:
        raise ValueError("Benchmark result does not contain onset scores")
    strict_score = tolerance_scores["50"]
    condition = {
        "referenceNotes": score["referenceNotes"],
        "predictedNotes": result["noteCount"],
        "matches": score["matches"],
        "precision": score["precision"],
        "recall": score["recall"],
        "f1": score["f1"],
        "score50Ms": {
            "matches": strict_score["matches"],
            "precision": strict_score["precision"],
            "recall": strict_score["recall"],
            "f1": strict_score["f1"],
        },
        "medianPredictionErrorMs": score["timing"][
            "medianPredictionErrorMs"
        ],
        "p95AbsoluteErrorMs": score["timing"]["p95AbsoluteErrorMs"],
        "crossInstrumentDuplicateGroups": result[
            "crossInstrumentDuplicates"
        ]["groups"],
    }
    if reference is not None:
        predicted = [
            ResultNote(
                instrument=str(row["instrument"]),
                pitch=int(row["pitch"]),
                start_sec=float(row["startSec"]),
                end_sec=float(row["endSec"]),
            )
            for row in result["notes"]
        ]
        condition["timingAndMismatchScore"] = _timing_and_mismatch_score(
            predicted,
            reference,
            onset_tolerance_sec=0.12,
            timing_penalty_sec=0.05,
            match_instruments=False,
        )
    return condition


def _aggregate_condition(
    cases: list[dict[str, Any]],
    condition: str,
) -> dict[str, Any]:
    results = [case["conditions"][condition] for case in cases]
    reference_notes = sum(item["referenceNotes"] for item in results)
    predicted_notes = sum(item["predictedNotes"] for item in results)
    matches = sum(item["matches"] for item in results)
    false_positives = predicted_notes - matches
    false_negatives = reference_notes - matches
    precision = _rounded_ratio(matches, predicted_notes)
    recall = _rounded_ratio(matches, reference_notes)
    f1_denominator = 2 * matches + false_positives + false_negatives
    f1 = (
        round(2 * matches / f1_denominator, 4)
        if f1_denominator
        else 0.0
    )
    median_errors = [
        item["medianPredictionErrorMs"]
        for item in results
        if item["medianPredictionErrorMs"] is not None
    ]
    p95_errors = [
        item["p95AbsoluteErrorMs"]
        for item in results
        if item["p95AbsoluteErrorMs"] is not None
    ]
    strict_matches = sum(item["score50Ms"]["matches"] for item in results)
    strict_false_positives = predicted_notes - strict_matches
    strict_false_negatives = reference_notes - strict_matches
    strict_precision = _rounded_ratio(strict_matches, predicted_notes)
    strict_recall = _rounded_ratio(strict_matches, reference_notes)
    strict_f1_denominator = (
        2 * strict_matches
        + strict_false_positives
        + strict_false_negatives
    )
    strict_f1 = (
        round(2 * strict_matches / strict_f1_denominator, 4)
        if strict_f1_denominator
        else 0.0
    )
    aggregate = {
        "referenceNotes": reference_notes,
        "predictedNotes": predicted_notes,
        "matches": matches,
        "falsePositiveNotes": false_positives,
        "falseNegativeNotes": false_negatives,
        "microPrecision": precision,
        "microRecall": recall,
        "microF1": f1,
        "macroF1": round(statistics.fmean(item["f1"] for item in results), 4),
        "score50Ms": {
            "matches": strict_matches,
            "falsePositiveNotes": strict_false_positives,
            "falseNegativeNotes": strict_false_negatives,
            "microPrecision": strict_precision,
            "microRecall": strict_recall,
            "microF1": strict_f1,
            "macroF1": round(
                statistics.fmean(item["score50Ms"]["f1"] for item in results),
                4,
            ),
        },
        "medianOfTrackMedianErrorMs": (
            round(statistics.median(median_errors), 1)
            if median_errors
            else None
        ),
        "medianOfTrackP95AbsoluteErrorMs": (
            round(statistics.median(p95_errors), 1) if p95_errors else None
        ),
        "crossInstrumentDuplicateGroups": sum(
            item["crossInstrumentDuplicateGroups"] for item in results
        ),
    }
    if all("timingAndMismatchScore" in item for item in results):
        aggregate["timingAndMismatchScore"] = (
            _aggregate_timing_and_mismatch(results)
        )
    return aggregate


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _run_score(
    *,
    repository: Path,
    output_path: Path,
    command: list[str],
    timeout_sec: int,
    reuse_results: bool,
) -> dict[str, Any]:
    if reuse_results and output_path.is_file():
        return _read_json(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        command,
        cwd=repository,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_sec,
        check=False,
    )
    if completed.returncode != 0:
        details = "\n".join(
            part.strip()
            for part in (completed.stdout, completed.stderr)
            if part.strip()
        )
        raise RuntimeError(
            f"Benchmark subprocess failed ({completed.returncode}):\n{details}"
        )
    if not output_path.is_file():
        raise RuntimeError(f"Benchmark did not create {output_path}")
    return _read_json(output_path)


def _gpu_summary() -> dict[str, str] | None:
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return None
    completed = subprocess.run(
        [
            executable,
            "--query-gpu=name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    name, memory_mib, driver = (
        part.strip() for part in completed.stdout.splitlines()[0].split(",", 2)
    )
    return {
        "name": name,
        "memoryMiB": memory_mib,
        "driverVersion": driver,
    }


def _git_revision(repository: Path) -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )
    return completed.stdout.strip() if completed.returncode == 0 else None


def _git_worktree_modified(repository: Path) -> bool | None:
    completed = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=repository,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )
    return bool(completed.stdout.strip()) if completed.returncode == 0 else None


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=(
            "Compare direct transcription, routed transcription after source "
            "separation, and the same routed method with drum-audio onset "
            "guidance."
        )
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
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=repository / "app" / "benchmark" / "public-results",
    )
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--timeout-sec", type=int, default=1200)
    parser.add_argument("--reuse-results", action="store_true")
    args = parser.parse_args()

    manifest = _read_json(args.manifest.resolve())
    dataset_root = args.dataset_root.resolve()
    model = args.model.resolve()
    stem_model = args.stem_model.resolve()
    if not model.is_file():
        raise FileNotFoundError(model)
    if not stem_model.exists():
        raise FileNotFoundError(stem_model)

    work_dir = args.work_dir.resolve()
    cases: list[dict[str, Any]] = []
    total_direct_elapsed = 0.0
    total_separated_routed_elapsed = 0.0
    total_separated_guided_no_note_filter_elapsed = 0.0
    total_separated_guided_elapsed = 0.0
    for index, segment in enumerate(manifest["segments"], start=1):
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
        print(
            f"[{index}/{len(manifest['segments'])}] {track_id}: direct",
            flush=True,
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
            args.backend,
            "--dtype",
            args.dtype,
            "--start",
            str(segment["startSec"]),
            "--duration",
            str(segment["durationSec"]),
        ]
        if args.ffmpeg is not None:
            common.extend(("--ffmpeg", str(args.ffmpeg.resolve())))
        direct_path = work_dir / "raw" / f"{track_id}-direct.json"
        direct = _run_score(
            repository=repository,
            output_path=direct_path,
            command=common
            + [
                "--mode",
                "direct",
                "--no-drum-onset-guide",
                "--output-json",
                str(direct_path),
            ],
            timeout_sec=args.timeout_sec,
            reuse_results=args.reuse_results,
        )
        print(
            f"[{index}/{len(manifest['segments'])}] "
            f"{track_id}: separated routed",
            flush=True,
        )
        separated_routed_path = (
            work_dir / "raw" / f"{track_id}-separated-routed.json"
        )
        separated_routed = _run_score(
            repository=repository,
            output_path=separated_routed_path,
            command=common
            + _separated_condition_arguments(
                drum_onset_guide=False,
                timing_guide_note_filter=False,
            )
            + [
                "--user-data",
                str(work_dir / "user-data" / track_id),
                "--output-json",
                str(separated_routed_path),
            ],
            timeout_sec=args.timeout_sec,
            reuse_results=args.reuse_results,
        )
        print(
            f"[{index}/{len(manifest['segments'])}] "
            f"{track_id}: separated routed with onset guide, no note filter",
            flush=True,
        )
        separated_guided_no_note_filter_path = (
            work_dir
            / "raw"
            / f"{track_id}-separated-routed-guided-no-note-filter.json"
        )
        separated_guided_no_note_filter = _run_score(
            repository=repository,
            output_path=separated_guided_no_note_filter_path,
            command=common
            + _separated_condition_arguments(
                drum_onset_guide=True,
                timing_guide_note_filter=False,
            )
            + [
                "--user-data",
                str(work_dir / "user-data" / track_id),
                "--output-json",
                str(separated_guided_no_note_filter_path),
            ],
            timeout_sec=args.timeout_sec,
            reuse_results=args.reuse_results,
        )
        print(
            f"[{index}/{len(manifest['segments'])}] "
            f"{track_id}: separated routed with onset guide and note filter",
            flush=True,
        )
        separated_guided_path = (
            work_dir / "raw" / f"{track_id}-separated-routed-guided.json"
        )
        separated_guided = _run_score(
            repository=repository,
            output_path=separated_guided_path,
            command=common
            + _separated_condition_arguments(
                drum_onset_guide=True,
                timing_guide_note_filter=True,
            )
            + [
                "--user-data",
                str(work_dir / "user-data" / track_id),
                "--output-json",
                str(separated_guided_path),
            ],
            timeout_sec=args.timeout_sec,
            reuse_results=args.reuse_results,
        )
        total_direct_elapsed += direct["elapsedSec"]
        total_separated_routed_elapsed += separated_routed["elapsedSec"]
        total_separated_guided_no_note_filter_elapsed += (
            separated_guided_no_note_filter["elapsedSec"]
        )
        total_separated_guided_elapsed += separated_guided["elapsedSec"]
        cases.append(
            {
                "trackId": track_id,
                "startSec": segment["startSec"],
                "durationSec": segment["durationSec"],
                "conditions": {
                    CONDITION_DIRECT: _condition_result(
                        direct,
                        reference,
                    ),
                    CONDITION_SEPARATED_ROUTED: _condition_result(
                        separated_routed,
                        reference,
                    ),
                    CONDITION_SEPARATED_ROUTED_GUIDED_NO_NOTE_FILTER: (
                        _condition_result(
                            separated_guided_no_note_filter,
                            reference,
                        )
                    ),
                    CONDITION_SEPARATED_ROUTED_GUIDED: _condition_result(
                        separated_guided,
                        reference,
                    ),
                },
                "runtimeSec": {
                    "direct": direct["elapsedSec"],
                    "separatedRoutedCold": separated_routed["elapsedSec"],
                    "separatedRoutedGuidedNoNoteFilterWarm": (
                        separated_guided_no_note_filter["elapsedSec"]
                    ),
                    "separatedRoutedGuidedWarm": separated_guided[
                        "elapsedSec"
                    ],
                },
            }
        )

    summary = {
        "schemaVersion": 5,
        "generatedAtUtc": datetime.now(UTC).isoformat(timespec="seconds"),
        "sourceRevision": _git_revision(repository),
        "sourceWorkingTreeModified": _git_worktree_modified(repository),
        "dataset": manifest["dataset"],
        "evaluation": {
            "segments": len(cases),
            "totalAudioSec": round(
                sum(case["durationSec"] for case in cases), 3
            ),
            "pitchMatch": "exact MIDI pitch",
            "onsetToleranceMs": 120,
            "additionalOnsetToleranceMs": [50],
            "fullTimingPenaltyMs": 50,
            "instrumentLabels": "ignored",
            "offsets": "not scored",
        },
        "configuration": {
            "transcriptionModel": model.parent.name,
            "backend": args.backend,
            "dtype": args.dtype,
            "instrumentSelection": "automatic",
            "sourceSeparation": {
                "drumComponentMixing": {
                    "drumOnsetGuide": True,
                    "inputs": [
                        name
                        for name, gain in separated_guided["settings"][
                            "timingGuideGains"
                        ].items()
                        if gain > 0.0
                    ],
                    "timingGuideGains": separated_guided["settings"][
                        "timingGuideGains"
                    ],
                    "bassTimingGuideHighpassHz": separated_guided[
                        "settings"
                    ]["bassTimingGuideHighpassHz"],
                    "discardDrumEvents": True,
                    "timingGuideNoteFilter": separated_guided["settings"][
                        "timingGuideNoteFilter"
                    ],
                },
            },
        },
        "environment": {
            "operatingSystem": platform.system(),
            "python": platform.python_version(),
            "gpu": _gpu_summary(),
        },
        "aggregate": {
            condition: _aggregate_condition(cases, condition)
            for condition in (
                CONDITION_DIRECT,
                CONDITION_SEPARATED_ROUTED,
                CONDITION_SEPARATED_ROUTED_GUIDED_NO_NOTE_FILTER,
                CONDITION_SEPARATED_ROUTED_GUIDED,
            )
        },
        "runtime": {
            "directTotalSec": round(total_direct_elapsed, 3),
            "separatedRoutedColdTotalSec": round(
                total_separated_routed_elapsed, 3
            ),
            "separatedRoutedGuidedWarmTotalSec": round(
                total_separated_guided_elapsed, 3
            ),
            "separatedRoutedGuidedNoNoteFilterWarmTotalSec": round(
                total_separated_guided_no_note_filter_elapsed,
                3,
            ),
            "separatedRoutedColdToDirectRatio": round(
                total_separated_routed_elapsed / total_direct_elapsed, 3
            )
            if total_direct_elapsed
            else None,
            "note": (
                "The routed condition includes source separation. The guided "
                "conditions reuse the same cached separated audio, so their "
                "elapsed times are not directly comparable with the cold routed "
                "condition."
            ),
        },
        "cases": cases,
    }
    rendered = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
