# MuScriptor 0.3.0 Beat Analysis and Onset Correction Comparison

[日本語](MUSCRIPTOR_030_EVALUATION.md)

## Scope

On 2026-10-18, the previous Librosa method (commit `9d248cd7bd2cc06ecd270ca5b2faa91febae4d60`) was compared with MuScriptor 0.3.0 beat analysis. Onset correction was evaluated before and after correction of the same MuScriptor medium transcription. The small, medium, and large transcription model weights are unchanged.

The environment was Windows, Python 3.11.15, MuScriptor 0.3.0, Beat This! 1.1.0, and PyTorch 2.2.2+cu121. Beat analysis used CPU; transcription used an NVIDIA GeForce RTX 3060 Laptop GPU and float16. The beat model was Beat This! final0, 81,058,141 bytes, SHA-256 `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`.

## Beat Analysis

The evaluation used the 50 tracks at odd filename positions within each genre, following the previous evaluation design, from the 100 30-second GTZAN mini recordings. These tracks were excluded from parameter selection for this update. GTZAN mini revision was `a61439e86c13037011fde8e0f0743ec55c50bce3`; Beat This! Annotations v1.1 revision was `890407d158078527ab396b49fea3c8a83e5734ee`. The [official Beat This! description](https://github.com/CPJKU/beat_this#available-models) states that final0 training excludes GTZAN.

Reference BPM was calculated from the median reference beat interval. Both methods received the same reference time signature. Their BPM and downbeat offset generated the evenly spaced beat and downbeat sequences displayed by the application. Events were matched one to one within 70 ms, and F1 was averaged across tracks. Tracks rejected by the new constant-tempo estimator counted as incorrect BPM estimates and zero beat and downbeat F1.

| Metric | Previous method | MuScriptor 0.3.0 |
|---|---:|---:|
| Tracks with a tempo estimate | 50 / 50 | 34 / 50 |
| BPM error within 4% | 27 / 50 (54%) | 32 / 50 (64%) |
| Beat macro F1 | 0.7347 | 0.6515 |
| Downbeat macro F1 | 0.3203 | 0.4917 |
| Processing time for 50 tracks | 7.91 seconds | 152.06 seconds |

Downbeat and BPM metrics improved, but 16 tracks were rejected by the constant-tempo estimator and beat macro F1 decreased. The application preserves the selected audio in that case and allows transcription with manually entered BPM and time signature. Processing time includes model loading and represents one measurement on this environment.

## Onset Correction

The evaluation used seconds 60–80 of the five tracks already defined in the BabySlakh v2 evaluation configuration `babyslakh_v2.json`: Track00001, Track00004, Track00010, Track00015, and Track00018. Total audio duration was 100 seconds. Each segment was transcribed once using MuScriptor medium, CUDA, float16, high accuracy, specified instruments, and direct transcription. The official MuScriptor common timing-offset correction was applied to the same notes after shared postprocessing.

To isolate timing correction, the evaluation script passed `fixedInstruments` from the configuration directly to the model. This differs from the application's default addition of instrument-family candidates.

SciPy linear assignment matched notes one to one by MIDI pitch and instrument, with a baseline onset difference of at most 120 ms. Before and after timing errors used the same 537 pairs. F1 matching was recalculated for each tolerance.

| Metric | Before correction | After correction |
|---|---:|---:|
| Mean absolute error of the same 537 pairs | 18.02 ms | 8.44 ms |
| Median signed onset error | +17.30 ms | +4.69 ms |
| 95th percentile absolute error | 28.10 ms | 27.00 ms |
| Onset micro F1 within 20 ms | 0.2547 | 0.3561 |
| Onset micro F1 within 50 ms | 0.3827 | 0.3827 |

Correction was applied to four of the five segments. Mean absolute error decreased by 53.13%, but Track00015 increased from 16.08 ms to 16.30 ms and Track00018 received a 0 ms correction. Pitch, instrument, and note count were unchanged. These five segments do not establish an improvement rate for other recordings, model sizes, or transcription after source separation.

## Implementation and Conditions

Beat analysis explicitly passes the local final0 checkpoint to MuScriptor `detect_grid` and uses results accepted by its constant-tempo test. Onset correction references the original audio's beat analysis and runs after shared postprocessing for each direct or separated transcription input and each reference transcription. MuScriptor `with_onset_delay` calculates the correction using the official conditions, including at least 40 distinct onset times, phase concentration of at least 0.5, and absolute correction of at most 40 ms. Corrections that cross the audio origin preserve note duration and limit the onset to 0 seconds.

The transcription cache stores events before correction; reuse applies correction once. Saved transcription-input notes contain corrected times, which are reused when transcription options are recalculated. The Windows application bundles the beat model at `resources/models/beat-this/final0.ckpt`.

## Records and Reproduction

See the [evaluation JSON](../benchmarks/data/muscriptor-030-beat-onset-comparison.json) for per-track metrics, rejected tracks, and audio and reference MIDI SHA-256 values.

Measure the previous method in a separate working directory at the baseline commit with the same 50 tracks and evaluation script. Run the new method in this order:

1. Download and verify the beat model with `uv run python scripts/download_beat_model.py`.
2. Evaluate beat analysis with `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/new-tempo.json`.
3. Download the audio with reference MIDI using `scripts/prepare_babyslakh_benchmark.ps1`.
4. Evaluate onset correction with `uv run python -m scripts.evaluate_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --output app/benchmark/onset-comparison.json`.

## Application Validation

| Validation | Result |
|---|---|
| `uv run pytest -q` | 344 passed, 1 failed, exit code 1 |
| `npm test -- --run` | 381 passed, exit code 0 |
| `npm run typecheck` | Exit code 0 |
| `npm run dist:win` | EXE generated, exit code 0 |
| `npm run smoke:packaged` | Exit code 0 for all three conditions: 8, 48, and 96 kHz |

The Python failure is `test_portable_build_includes_release_documents`. A release-note edit already present before this task removes the `SHA-256` text required by the existing test. Without changing that file, a targeted test that substituted only its read value with the baseline commit's content passed: 1 passed, exit code 0.

An acceptance test using the generated EXE's bundled backend and actual HTTP/SSE verified registration of small, medium, and large, beat analysis with bundled final0, and 20-second Track00010 transcription with medium, CUDA, and float16. With the application's default instrument-family candidate expansion, it produced 416 notes and corrected a common onset offset of 15.9725 ms. Each 8, 48, and 96 kHz EXE test verified local audio playback, SoundFont playback, MusicXML display, 100,000-note rendering, and zero residual processes after exit. All three existing `UserData` files retained their pre-build SHA-256 values.
