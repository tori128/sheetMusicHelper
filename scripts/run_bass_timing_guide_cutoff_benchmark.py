from __future__ import annotations

import argparse
import json
import platform
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from scripts.compare_muscriptor_variants import (
        _crop_reference_notes,
        _reference_notes,
    )
    from scripts.run_public_transcription_benchmark import (
        _git_revision,
        _git_worktree_modified,
        _gpu_summary,
        _read_json,
        _run_score,
    )
    from scripts.run_timing_guide_gain_benchmark import (
        PRODUCT_GAINS,
        TARGET_FAMILIES,
        _family_condition,
        _gain_arguments,
        _micro_aggregate,
        _notes,
    )
except ModuleNotFoundError:
    from compare_muscriptor_variants import (
        _crop_reference_notes,
        _reference_notes,
    )
    from run_public_transcription_benchmark import (
        _git_revision,
        _git_worktree_modified,
        _gpu_summary,
        _read_json,
        _run_score,
    )
    from run_timing_guide_gain_benchmark import (
        PRODUCT_GAINS,
        TARGET_FAMILIES,
        _family_condition,
        _gain_arguments,
        _micro_aggregate,
        _notes,
    )


CUTOFFS_HZ = (125.0, 180.0, 250.0, 350.0, 500.0, 750.0)
BASS_FALSE_PITCH_HZ = 138.59
ATTACK_REFERENCE_HZ = 2_000.0
MINIMUM_ATTACK_TO_BASS_RATIO = 8.0


def _condition_id(cutoff_hz: float) -> str:
    return f"hpf-{cutoff_hz:g}".replace(".", "p")


def _attack_to_bass_ratio(cutoff_hz: float) -> float:
    from scipy.signal import butter, sosfreqz

    filter_sections = butter(
        4,
        cutoff_hz,
        btype="highpass",
        fs=48_000,
        output="sos",
    )
    _frequencies, response = sosfreqz(
        filter_sections,
        worN=[BASS_FALSE_PITCH_HZ, ATTACK_REFERENCE_HZ],
        fs=48_000,
    )
    return float(abs(response[1]) / max(abs(response[0]), 1e-12))


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Measure bass drum-guide high-pass frequencies on BabySlakh."
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
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--timeout-sec", type=int, default=1200)
    parser.add_argument("--reuse-results", action="store_true")
    parser.add_argument(
        "--cutoffs-hz",
        nargs="+",
        type=float,
        default=list(CUTOFFS_HZ),
    )
    parser.add_argument("--gain", type=float, default=0.2)
    args = parser.parse_args()

    cutoffs_hz = tuple(sorted(set(args.cutoffs_hz)))
    if not cutoffs_hz or any(value <= 0.0 for value in cutoffs_hz):
        parser.error("--cutoffs-hz must contain positive values")
    if not 0.0 <= args.gain <= 1.0:
        parser.error("--gain must be between 0 and 1")

    manifest = _read_json(args.manifest.resolve())
    dataset_root = args.dataset_root.resolve()
    model = args.model.resolve()
    stem_model = args.stem_model.resolve()
    work_dir = args.work_dir.resolve()
    if not model.is_file():
        raise FileNotFoundError(model)
    if not stem_model.exists():
        raise FileNotFoundError(stem_model)

    cases: list[dict[str, Any]] = []
    segments = manifest["segments"]
    for case_index, segment in enumerate(segments, start=1):
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
        ] + _gain_arguments({**PRODUCT_GAINS, "bass": args.gain})
        if args.ffmpeg is not None:
            common.extend(("--ffmpeg", str(args.ffmpeg.resolve())))

        conditions: dict[str, Any] = {}
        runtimes: dict[str, float] = {}
        for variant_index, cutoff_hz in enumerate(cutoffs_hz, start=1):
            condition_id = _condition_id(cutoff_hz)
            print(
                f"[{case_index}/{len(segments)}] {track_id} "
                f"[{variant_index}/{len(cutoffs_hz)}] {condition_id}",
                flush=True,
            )
            output_path = work_dir / "raw" / f"{track_id}-{condition_id}.json"
            raw = _run_score(
                repository=repository,
                output_path=output_path,
                command=common
                + [
                    "--bass-timing-guide-highpass-hz",
                    str(cutoff_hz),
                    "--output-json",
                    str(output_path),
                ],
                timeout_sec=args.timeout_sec,
                reuse_results=args.reuse_results,
            )
            conditions[condition_id] = _family_condition(
                _notes(raw["notes"]),
                reference,
                TARGET_FAMILIES["bass"],
            )
            runtimes[condition_id] = float(raw["elapsedSec"])
        cases.append(
            {
                "trackId": track_id,
                "conditions": conditions,
                "runtimeSec": runtimes,
            }
        )

    aggregate: dict[str, Any] = {}
    for cutoff_hz in cutoffs_hz:
        condition_id = _condition_id(cutoff_hz)
        aggregate[str(cutoff_hz)] = _micro_aggregate(
            [case["conditions"][condition_id] for case in cases]
        )
    attack_to_bass_ratio = {
        cutoff_hz: _attack_to_bass_ratio(cutoff_hz)
        for cutoff_hz in cutoffs_hz
    }
    eligible_cutoffs = tuple(
        cutoff_hz
        for cutoff_hz in cutoffs_hz
        if attack_to_bass_ratio[cutoff_hz] >= MINIMUM_ATTACK_TO_BASS_RATIO
    )
    if not eligible_cutoffs:
        parser.error(
            "No cutoff suppresses C-sharp 3 by the required frequency ratio"
        )
    selected_cutoff_hz = min(
        eligible_cutoffs,
        key=lambda cutoff_hz: (
            -aggregate[str(cutoff_hz)]["timingAndMismatchScore"]["score"],
            cutoff_hz,
        ),
    )

    result = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(UTC).isoformat(timespec="seconds"),
        "sourceRevision": _git_revision(repository),
        "sourceWorkingTreeModified": _git_worktree_modified(repository),
        "dataset": manifest["dataset"],
        "evaluation": {
            "segments": len(cases),
            "totalAudioSec": sum(float(item["durationSec"]) for item in segments),
            "cutoffsHz": list(cutoffs_hz),
            "gain": args.gain,
            "reportedOnsetTolerancesMs": [20, 50, 120],
            "offsets": "not scored",
            "selectionRule": (
                "require the 2 kHz response to be at least eight times the "
                "138.59 Hz response, then select the highest bass "
                "timing-and-mismatch score; choose the lower cutoff only "
                "when scores are equal"
            ),
        },
        "configuration": {
            "transcriptionModel": model.parent.name,
            "backend": "CUDA",
            "dtype": "float16",
            "instrumentSelection": "automatic",
            "discardDrumEvents": True,
            "timingGuideNoteFilter": True,
            "timingGuideGainsExceptBass": {
                name: gain
                for name, gain in PRODUCT_GAINS.items()
                if name != "bass"
            },
        },
        "environment": {
            "gpu": _gpu_summary(),
            "python": platform.python_version(),
        },
        "selectedCutoffHz": selected_cutoff_hz,
        "attackToBassFrequencyRatio": {
            str(cutoff_hz): round(ratio, 4)
            for cutoff_hz, ratio in attack_to_bass_ratio.items()
        },
        "aggregate": aggregate,
        "cases": cases,
    }
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"selectedCutoffHz": selected_cutoff_hz}, indent=2))


if __name__ == "__main__":
    main()
