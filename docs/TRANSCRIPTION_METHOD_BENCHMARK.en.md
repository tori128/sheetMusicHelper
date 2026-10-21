# Transcription Methods on a Public Dataset

[日本語](TRANSCRIPTION_METHOD_BENCHMARK.md)

## Evaluation Conditions

Measured on 2026-10-21 with EarCopy Assist 0.1.6, MuScriptor 0.4.0, PyTorch 2.5.1+cu121, and NumPy 2.2.6 on Windows, Python 3.11.15, and an NVIDIA GeForce RTX 3060 Laptop GPU.

The dataset comprised seconds 60–80 of BabySlakh v2 Track00001, Track00004, Track00010, Track00015, and Track00018: 100 seconds and 1,427 reference notes in total. The archive MD5 is `311096dc2bde7d61c97e930edbfc7f78`. Instrument selections came from the [evaluation manifest](../scripts/benchmark_cases/babyslakh_v2.json).

MuScriptor medium ran on CUDA in float16, using high-accuracy transcription and specified instruments, family expansion, and duplicate-note removal. Separation used BS-RoFormer SW Fixed. Separated transcription enabled the drum guide, pitch-error filtering, and stem-amplitude velocity. Drum-guide gain was 20%; the drum guide added to Bass used a 350 Hz fourth-order Butterworth high-pass filter.

## Metrics

F1 used one-to-one matches on MIDI pitch, estimated instrument, and onset tolerance, counting all output and reference notes. Mean absolute onset error compared the same note IDs paired within 120 ms before correction. Corrected transcription ran first; uncorrected runs reused the same separated audio and transcription events. Corresponding note IDs, pitches, instruments, output tracks, and note counts were identical across correction states for all ten conditions.

## Results

| Method | Output notes | Timing correction | F1 @20 ms | F1 @50 ms | Mean absolute onset error |
|---|---:|---|---:|---:|---:|
| Direct | 1,463 | Off | 0.2291 | 0.3682 | 18.41 ms |
| Direct | 1,463 | On | 0.3370 | 0.3696 | 9.17 ms |
| After separation | 1,301 | Off | 0.2771 | 0.3864 | 17.58 ms |
| After separation | 1,301 | On | 0.3607 | 0.3871 | 11.21 ms |

The timing-error analysis paired 538 notes for direct transcription and 543 after separation. Mean absolute error fell by 50.16% and 36.20%, respectively. Nonzero correction was applied to 6 of 29 primary separated inputs.

The five corrected jobs took 90.44 seconds directly and 209.34 seconds after separation. Original-audio beat analysis ran on CPU with two threads and was reused for separated transcription. Separated audio and transcription events were newly computed. Timing-correction calculation and note updates totaled 6.84 ms and 11.40 ms. PyInstaller and GTZAN evaluation overlapped with parts of the measurement, so timings cannot support speed comparisons with other runs.

See the [evaluation JSON](benchmarks/data/muscriptor-application-onset-comparison.json) for per-track/input metrics and SHA-256 values, and the [beat analysis and onset correction evaluation](developer/MUSCRIPTOR_EVALUATION.en.md) for implementation conditions.

## Limitations

These results cover five synthetic excerpts, the medium model, and specified instruments. They do not establish performance on all real recordings or complete songs. Matched-note sets differ between direct and separated transcription, so mean absolute error alone cannot rank the two modes. Model weights were unchanged, but runtime libraries also changed; output differences from the preceding version cannot be attributed solely to MuScriptor.

## Reproduction

1. `scripts/prepare_babyslakh_benchmark.ps1 -Destination app/benchmark/public-data`
2. `uv run python scripts/download_beat_model.py`
3. `uv run python -m scripts.evaluate_application_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --work-dir app/benchmark/latest-onset --output app/benchmark/application-onset-comparison.json`

Choose a new work directory to compute fresh results.

## References

- [BabySlakh v2](https://doi.org/10.5281/zenodo.4603870)
