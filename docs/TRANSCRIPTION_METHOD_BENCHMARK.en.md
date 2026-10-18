# Transcription Methods on a Public Dataset

[日本語](TRANSCRIPTION_METHOD_BENCHMARK.md)

## Evaluation Conditions

On 2026-10-18, direct and separated transcription were compared through the application using MuScriptor 0.3.0.

| Item | Condition |
|---|---|
| Dataset | BabySlakh v2 |
| Segments | Seconds 60–80 of Track00001, Track00004, Track00010, Track00015, and Track00018; 100 seconds total |
| Reference notes | 1,427 notes matched by MIDI pitch and instrument |
| Transcription | MuScriptor medium, CUDA, float16, high accuracy, specified instruments |
| Separation | BS-RoFormer SW Fixed |
| Beat analysis | Original audio, Beat This! final0, CPU |

Instrument information came from the [evaluation manifest](../scripts/benchmark_cases/babyslakh_v2.json). The application's default instrument-family candidate expansion and duplicate-note removal were enabled. Separated transcription enabled added drums, pitch false-positive reduction, and velocity assignment from separated audio amplitude. Added drums used a 20% gain; the drums added to Bass used a 350 Hz fourth-order Butterworth high-pass filter.

The BabySlakh v2 archive MD5 is `311096dc2bde7d61c97e930edbfc7f78`.

## Metrics

F1 uses one-to-one matching by MIDI pitch, detected instrument, and onset time within the tolerance, calculated over all predicted and reference notes. Mean absolute onset error compares the same note IDs matched within 120 ms before correction.

## Results

Each method used the same separated audio and transcription events to compare MuScriptor 0.3.0 onset correction on and off.

| Method | Predicted notes | Correction | F1 @20 ms | F1 @50 ms | Mean absolute onset error |
|---|---:|---|---:|---:|---:|
| Direct | 1,444 | Off | 0.2306 | 0.3706 | 18.58 ms |
| Direct | 1,444 | On | 0.3393 | 0.3720 | 9.10 ms |
| Separated | 1,298 | Off | 0.2774 | 0.3868 | 17.58 ms |
| Separated | 1,298 | On | 0.3611 | 0.3875 | 11.22 ms |

Timing-error matching used 539 pairs for direct transcription and 543 for separated transcription. Separated transcription reduced mean absolute error by 36.15% and applied nonzero correction to 6 of 29 primary inputs. Error decreased on three tracks, increased on one, and remained unchanged on one. At 50 ms tolerance, matched notes increased from 527 to 528.

Total corrected processing time for the five segments was 91.65 seconds for direct transcription and 239.93 seconds for separated transcription. Separated mode ran after direct mode and reused the prepared WAV and original-audio beat analysis. Separated audio and transcription events were calculated anew. Calculating correction and changing note times took 6.75 ms and 13.84 ms in total.

See the [evaluation JSON](benchmarks/data/muscriptor-030-application-onset-comparison.json) for per-track and per-input metrics and model/audio SHA-256 values, and the [beat analysis and onset correction evaluation](developer/MUSCRIPTOR_030_EVALUATION.en.md) for implementation conditions.

## Limitations

- The evaluation covers five synthesized BabySlakh v2 segments totaling 100 seconds; these values do not establish performance on recordings generally or on complete tracks.
- Conditions were the medium model, CUDA, float16, and instruments specified from dataset information.
- Matched-note populations differ between methods, so mean absolute error alone cannot establish which separation mode performs better.
- Processing times represent one measurement per condition on an NVIDIA GeForce RTX 3060 Laptop GPU environment.

## Reproduction

1. Prepare the audio with `scripts/prepare_babyslakh_benchmark.ps1 -Destination app/benchmark/public-data`.
2. Download and verify the beat model with `uv run python scripts/download_beat_model.py`.
3. Compare with `uv run python -m scripts.evaluate_application_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --work-dir app/benchmark/latest-onset --output app/benchmark/application-onset-comparison.json`. Use a new working directory to calculate results anew.

## References

- [BabySlakh v2](https://doi.org/10.5281/zenodo.4603870)
