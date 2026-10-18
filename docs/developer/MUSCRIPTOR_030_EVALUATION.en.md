# MuScriptor 0.3.0 Beat Analysis and Onset Correction Comparison

[日本語](MUSCRIPTOR_030_EVALUATION.md)

## Scope

On 2026-10-19, the previous Librosa method (commit `9d248cd7bd2cc06ecd270ca5b2faa91febae4d60`) was compared with EarCopy Assist 0.1.5 beat analysis using MuScriptor 0.3.0 and robust tempo fitting. Onset correction was evaluated on 2026-10-18 before and after correction of the same MuScriptor medium transcription. The small, medium, and large transcription model weights are unchanged.

The environment was Windows, Python 3.11.15, MuScriptor 0.3.0, Beat This! 1.1.0, and PyTorch 2.2.2+cu121. Beat analysis used CPU; transcription used an NVIDIA GeForce RTX 3060 Laptop GPU and float16. The beat model was Beat This! final0, 81,058,141 bytes, SHA-256 `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`.

## Beat Analysis

The evaluation used the 50 tracks at odd filename positions within each genre, following the previous evaluation design, from the 100 30-second GTZAN mini recordings. These tracks were excluded from parameter selection for this update. GTZAN mini revision was `a61439e86c13037011fde8e0f0743ec55c50bce3`; Beat This! Annotations v1.1 revision was `890407d158078527ab396b49fea3c8a83e5734ee`. The [official Beat This! description](https://github.com/CPJKU/beat_this#available-models) states that final0 training excludes GTZAN.

Reference BPM was calculated from the median reference beat interval. Both methods received the same reference time signature. Their BPM and downbeat offset generated the evenly spaced beat and downbeat sequences displayed by the application. Events were matched one to one within 70 ms, and F1 was averaged across tracks. Tracks rejected by the new constant-tempo estimator counted as incorrect BPM estimates and zero beat and downbeat F1.

| Metric | Previous method | EarCopy Assist 0.1.5 |
|---|---:|---:|
| Tracks with a tempo estimate | 50 / 50 | 41 / 50 |
| BPM error within 4% | 27 / 50 (54%) | 37 / 50 (74%) |
| Beat macro F1 | 0.7347 | 0.7437 |
| Downbeat macro F1 | 0.3203 | 0.5517 |
| Processing time for 50 tracks | 7.91 seconds | 473.79 seconds |

Tempo was returned for 41/50 tracks; 37/50 estimates were within 4% of reference BPM. The remaining nine tracks permit transcription with manually entered BPM and time signature. The current run used two PyTorch CPU threads while CUDA transcription and a PyInstaller build were active. Timings include model loading and different concurrent workloads; they are not a controlled latency comparison.

## Direct and Separated Transcription Using the Application Pipeline

The same five tracks at seconds 60–80 were processed in direct and separated modes through `TranscriptionJobManager` at commit `44a9e9ea643a1a27e3fac3adde42ae658b53e694`. Conditions were MuScriptor medium, CUDA, float16, high accuracy, and specified instruments. The same `fixedInstruments` were used, with the application's default instrument-family candidate expansion and duplicate-note removal enabled. The separation model was BS-RoFormer SW Fixed.

Separated transcription enabled all three application defaults: added drums, pitch false-positive reduction, and velocity assignment from separated audio amplitude. Added drums used a 20% gain; only the drums added to Bass passed through a 350 Hz fourth-order Butterworth high-pass filter. Beat analysis used the original audio, and timing correction also applied to reference transcriptions of the unmodified separated audio.

Each condition first ran transcription with correction enabled. A comparison run then reused exactly the same separated audio and cached transcription events, disabling only timing correction. This isolated correction from repeated model inference while retaining the complete application pipeline, including subsequent note selection and velocity assignment. Corresponding note IDs, pitches, detected instruments, output tracks, and note counts were identical across all 10 condition pairs.

One-to-one matching required identical MIDI pitch and detected instrument and a baseline onset difference of at most 120 ms. The same note IDs were tracked before and after correction. F1 used all 1,427 reference notes and all output notes for each condition, with matching recalculated at each tolerance.

| Method | Same matched note pairs | MAE without correction | MAE with correction | Reduction |
|---|---:|---:|---:|---:|
| Direct transcription | 539 | 18.58 ms | 9.10 ms | 51.02% |
| Separated transcription | 543 | 17.58 ms | 11.22 ms | 36.15% |

| Method | 20 ms F1 without correction | 20 ms F1 with correction | 50 ms F1 without correction | 50 ms F1 with correction |
|---|---:|---:|---:|---:|
| Direct transcription | 0.2306 | 0.3393 | 0.3706 | 0.3720 |
| Separated transcription | 0.2774 | 0.3611 | 0.3868 | 0.3875 |

| Track | Direct MAE, without → with correction | Separated MAE, without → with correction |
|---|---:|---:|
| Track00001 | 16.86 → 14.89 ms | 17.06 → 17.35 ms |
| Track00004 | 17.51 → 6.37 ms | 9.80 → 7.78 ms |
| Track00010 | 21.14 → 5.72 ms | 19.39 → 7.96 ms |
| Track00015 | 18.53 → 18.16 ms | 20.96 → 19.82 ms |
| Track00018 | 3.62 → 3.62 ms | 17.43 → 17.43 ms |

Separated transcription applied a nonzero correction to 6 of 29 primary inputs. Error decreased on three tracks, increased on one, and one received a 0 ms correction. At 50 ms tolerance, matched notes increased from 527 to 528, with 1,298 output notes. The principal measured change was reduced onset error for notes already detected.

Total corrected processing time for the five segments was 91.65 seconds in direct mode and 239.93 seconds in separated mode. Direct mode ran first; separated mode reused the prepared WAV and original-audio beat analysis. Separated audio and transcription events were calculated anew for each condition. Calculating correction and changing note times took 6.75 ms and 13.84 ms in total. Processing times represent one measurement per condition on this environment.

This compares timing correction on and off for 20-second segments, the medium model, and specified instruments. The matched-note populations differ between direct and separated modes, so their MAE values alone cannot establish which mode performs better. Correction coverage on 20-second segments may differ from coverage on complete tracks.

See the [additional application-pipeline comparison JSON](../benchmarks/data/muscriptor-030-application-onset-comparison.json) for per-track and per-input metrics and SHA-256 values for models, audio, and separated audio.

## Implementation and Conditions

Beat This! `Audio2Beats` detects beat times using an explicitly supplied local final0 checkpoint. Beat indices accumulate beat intervals rounded relative to their median, accounting for missed and extra detections. SciPy `least_squares` fits a line with Soft-L1 loss. At least eight beats are required, and the median absolute residual must be within 5% of the fitted beat period. Meter estimation and onset correction use MuScriptor utilities; correction retains the original detected beat times. Onset correction references the original audio's beat analysis and runs after shared postprocessing for each direct or separated transcription input and each reference transcription. MuScriptor `with_onset_delay` calculates the correction using the official conditions, including at least 40 distinct onset times, phase concentration of at least 0.5, and absolute correction of at most 40 ms. Corrections that cross the audio origin preserve note duration and limit the onset to 0 seconds.

The transcription cache stores events before correction; reuse applies correction once. Saved transcription-input notes contain corrected times, which are reused when transcription options are recalculated. The Windows application bundles the beat model at `resources/models/beat-this/final0.ckpt`.

## Records and Reproduction

See the [evaluation JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json) for per-track beat metrics and rejected tracks; the application-pipeline JSON above records transcription audio and reference MIDI SHA-256 values.

Measure the previous method in a separate working directory at the baseline commit with the same 50 tracks and evaluation script. Run the new method in this order:

1. Download and verify the beat model with `uv run python scripts/download_beat_model.py`.
2. Evaluate beat analysis with `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/new-tempo.json`.
3. Download the audio with reference MIDI using `scripts/prepare_babyslakh_benchmark.ps1`.
4. Compare the application pipeline's direct and separated modes with `uv run python -m scripts.evaluate_application_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --output app/benchmark/application-onset-comparison.json`. Use a new `--work-dir` to calculate separated audio and transcription events anew.
