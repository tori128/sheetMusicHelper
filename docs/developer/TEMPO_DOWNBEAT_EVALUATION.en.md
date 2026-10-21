# Public Tempo, Beat, and Downbeat Evaluation

[日本語](TEMPO_DOWNBEAT_EVALUATION.md)

## Evaluation Conditions

On 2026-10-21, EarCopy Assist 0.1.6 beat analysis using MuScriptor 0.4.0 was evaluated on Windows with Python 3.11.15, PyTorch 2.5.1+cu121, NumPy 2.2.6, and Beat This! 1.1.0. Beat This! final0 ran on CPU with two threads. Transcription and beat-model weights were unchanged.

The 100 30-second GTZAN mini recordings were split by filename position within each genre. The 50 even-positioned tracks were used for method selection, followed by the 50 odd-positioned evaluation tracks. Each method received the same reference meter. Beat This! inference ran once per track, with the same detected beat times reused by all beat-grid fitting methods. Librosa ran separately.

| Dataset | Revision |
|---|---|
| GTZAN mini | `a61439e86c13037011fde8e0f0743ec55c50bce3` |
| Beat This! Annotations v1.1 | `890407d158078527ab396b49fea3c8a83e5734ee` |

## Metrics and Results

Reference BPM came from the median reference beat interval. Estimated BPM and downbeat offset generated evenly spaced beat sequences; events were matched one to one within 70 ms and F1 was averaged across tracks. Unavailable estimates counted as incorrect BPM and zero beat/downbeat F1.

| Metric | Legacy Librosa | 0.1.5 beat-grid fitting | 0.1.6 / MuScriptor 0.4.0 |
|---|---:|---:|---:|
| Tracks with a tempo estimate | 50 / 50 | 41 / 50 | 50 / 50 |
| BPM error within 4% | 54% | 74% | 84% |
| Beat macro F1 | 0.7347 | 0.7437 | 0.7629 |
| Downbeat macro F1 | 0.3203 | 0.5517 | 0.5746 |
| Beat micro F1 | 0.7503 | 0.8234 | 0.7663 |
| Downbeat micro F1 | 0.3342 | 0.5966 | 0.5623 |
| Median absolute percentage error among returned BPMs | 1.3305% | 0.1692% | 0.2825% |

Version 0.4.0 returned BPM for all 50 tracks, with 42 within 4% error. It returned average BPM for the nine recordings rejected by the preceding fit. BPM accuracy and track-averaged F1 increased, but median BPM error among the differing sets of returned estimates and event-aggregated micro F1 worsened. The results therefore do not show improvement on every metric. Automatic meter accuracy was outside this evaluation.

## Comparison with Switching to the Legacy Method

A candidate switched to Librosa when the beat grid was non-steady or had too few beats, using MuScriptor 0.4.0's `steady` flag.

| Split | Metric | 0.4.0 alone | Switch to Librosa |
|---|---|---:|---:|
| 50 development tracks | BPM error within 4% | 86% | 80% |
| 50 development tracks | Beat macro F1 | 0.7612 | 0.8176 |
| 50 development tracks | Downbeat macro F1 | 0.6742 | 0.6640 |
| 50 evaluation tracks | BPM error within 4% | 84% | 84% |
| 50 evaluation tracks | Beat macro F1 | 0.7629 | 0.8307 |
| 50 evaluation tracks | Downbeat macro F1 | 0.5746 | 0.5315 |

Version 0.4.0 alone was selected for its higher BPM accuracy and downbeat macro F1 on the development tracks. Switching to Librosa improved beat macro F1 while lowering downbeat macro F1, demonstrating a tradeoff between metrics.

## Implementation and Regression Check

The application's Soft-L1 fit was removed in favor of MuScriptor 0.4.0's `detect_grid`, explicitly given the local final0 checkpoint. The official `regularized_beats` interpolates missed beats and removes extra detections. With at least eight beats, non-steady recordings also yield average BPM. The piano roll, quantization, and exports use the same BPM throughout the recording.

The previously rejected 269.537-second recording returned 135.970154 BPM, 4/4 meter, and a downbeat offset of 0.620 seconds. Its tempo was classified as non-steady, but the application accepted the recording and assigned the average BPM.

Timings are recorded in the [evaluation JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json). Shared beat inference and concurrent regression tests, CUDA transcription, and PyInstaller work during parts of the measurement make them unsuitable for comparing independent end-to-end latency.

## Reproduction

1. Obtain [GTZAN mini](https://github.com/TempoBeatDownbeat/gtzan_mini) and [Beat This! Annotations v1.1](https://github.com/CPJKU/beat_this_annotations/tree/v1.1/gtzan), selecting the revisions above.
2. Download and verify the beat model with `uv run python scripts/download_beat_model.py`.
3. Evaluate the current application on 50 tracks with `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/tempo-downbeat.json`.

See the [beat analysis and onset correction evaluation](MUSCRIPTOR_EVALUATION.en.md) for onset correction and transcription measurements.
