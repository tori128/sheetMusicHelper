# Public Tempo, Beat, and Downbeat Evaluation

[日本語](TEMPO_DOWNBEAT_EVALUATION.md)

## Evaluation Conditions

On 2026-10-19, EarCopy Assist 0.1.5 beat analysis, using MuScriptor 0.3.0, Beat This! final0, and Soft-L1 robust tempo fitting, was compared with the preceding Librosa baseline. The evaluation used 50 of the 100 30-second GTZAN mini recordings, at odd filename positions within each genre. These tracks were excluded from parameter selection for this update. Both methods received the same reference time signature.

| Dataset | Revision |
|---|---|
| GTZAN mini | `a61439e86c13037011fde8e0f0743ec55c50bce3` |
| Beat This! Annotations v1.1 | `890407d158078527ab396b49fea3c8a83e5734ee` |

## Metrics and Results

Reference BPM came from the median reference beat interval. Estimated BPM and downbeat offset generated evenly spaced beat sequences; events were matched one to one within 70 ms and F1 was averaged across tracks. Rejected constant-tempo estimates counted as incorrect BPM and zero beat/downbeat F1.

| Metric | Immediately preceding Librosa method | EarCopy Assist 0.1.5 |
|---|---:|---:|
| Tracks with a tempo estimate | 50 / 50 | 41 / 50 |
| BPM error within 4% | 54% | 74% |
| Beat macro F1 | 0.7347 | 0.7437 |
| Downbeat macro F1 | 0.3203 | 0.5517 |
| Processing time for 50 tracks | 7.91 seconds | 473.79 seconds |

Tempo was returned for 41/50 tracks; 37/50 estimates were within 4% of reference BPM. The remaining nine tracks permit transcription with manually entered BPM and time signature. Automatic meter accuracy was outside this comparison. The current run used two PyTorch CPU threads while CUDA transcription and a PyInstaller build were active. Timings include model loading and different concurrent workloads; they are not a controlled latency comparison.

See the [evaluation JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json) for per-track metrics and the [beat analysis and onset correction evaluation](MUSCRIPTOR_030_EVALUATION.en.md) for model and implementation conditions.

## Reproduction

1. Obtain [GTZAN mini](https://github.com/TempoBeatDownbeat/gtzan_mini) and [Beat This! Annotations v1.1](https://github.com/CPJKU/beat_this_annotations/tree/v1.1/gtzan), selecting the revisions above.
2. Download and verify the beat model with `uv run python scripts/download_beat_model.py`.
3. Evaluate the 50 tracks with `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/tempo-downbeat.json`.
