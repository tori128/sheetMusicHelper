# Transcription Methods on a Public Dataset

[日本語](TRANSCRIPTION_METHOD_BENCHMARK.md)

## Overview

This report evaluates how source separation, drum-assisted onset processing, note validation, and instrument selection affect transcription accuracy under the recommended EarCopy Assist defaults. The evaluation uses the public BabySlakh v2 dataset.

## Evaluation Conditions

| Item | Condition |
|---|---|
| Dataset | BabySlakh v2 |
| Excerpts | Seconds 60–80 of `Track00001`, `Track00004`, `Track00010`, `Track00015`, and `Track00018`; 100 seconds total |
| Reference notes | 1,433 for pitch evaluation; 1,427 for instrument-aware evaluation |
| Transcription model | MuScriptor medium |
| Inference | CUDA, FP16 |
| Source separation | BS-RoFormer SW Fixed |

The excerpts are recorded in the [evaluation manifest](../scripts/benchmark_cases/babyslakh_v2.json). The MD5 checksum of the BabySlakh v2 archive is `311096dc2bde7d61c97e930edbfc7f78`.

## Metrics

Precision, recall, and micro F1 at 50 ms use one-to-one matches between notes with the same MIDI pitch and onset times within 50 ms.

Onset-weighted F1 matches notes with the same MIDI pitch and onset times within 120 ms. A match receives one point at 0 ms, zero points at 50 ms or later, and a linearly interpolated value from 0 to 50 ms. If `T` is the sum of match points, `P` is the number of predicted notes, and `R` is the number of reference notes, onset-weighted F1 is `2T / (P + R)`. The onset score in the table is `T / matched notes`. The mismatch rate is `(false positives + false negatives) / (P + R)`.

Instrument-aware F1 also requires the predicted track's instrument class to match.

## Transcription Method Comparison

The following four conditions use the same five excerpts.

| Condition | Processing |
|---:|---|
| 1 | Transcribe the original audio without source separation |
| 2 | Separate the audio, then transcribe each component with component-specific instrument candidates |
| 3 | Add a 20% drum mix to Bass, Piano, Guitar, Vocal, and Other in condition 2, then reject notes classified as drums |
| 4 | Add note validation to condition 3 for Bass, Piano, Guitar, and Other: require equal-pitch evidence within 2.5 seconds in the same component without the drum mix |

The drum signal mixed into Bass passes through a fourth-order Butterworth high-pass filter with a 350 Hz cutoff. Condition 4 corresponds to the recommended defaults with onset-time error reduction and pitch false-positive reduction enabled.

| Method | Predicted notes | Matches @50 ms | Precision @50 ms | Recall @50 ms | F1 @50 ms | Mismatch rate | Onset score | Onset-weighted F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1. No source separation | 904 | 462 | 0.5111 | 0.3224 | 0.3954 | 0.5866 | 0.6065 | 0.2507 |
| 2. Source separation and component-specific candidates | 1,350 | **731** | 0.5415 | **0.5101** | **0.5253** | **0.4337** | 0.6638 | **0.3759** |
| 3. Condition 2 and 20% drum mixing | 1,430 | 718 | 0.5021 | 0.5010 | 0.5016 | 0.4705 | 0.6672 | 0.3533 |
| 4. Condition 3 and note validation | 1,284 | 702 | **0.5467** | 0.4899 | 0.5167 | 0.4575 | **0.6720** | 0.3646 |

Condition 2 increased 50 ms F1 by `0.1299` and onset-weighted F1 by `0.1252` over direct transcription. Its mismatch rate was `0.1529` lower.

Relative to condition 2, condition 4 increased the onset score by `0.0082` and reduced the median per-excerpt 95th-percentile absolute onset error from 69.7 ms to 31.0 ms. However, 50 ms F1 was `0.0086` lower, recall was `0.0202` lower, onset-weighted F1 was `0.0113` lower, and the mismatch rate was `0.0238` higher. In this 100-second evaluation, drum-assisted processing improved the onset-error distribution but did not exceed condition 2 on aggregate metrics that include note detection counts.

Note validation in condition 4 removed 146 predictions relative to condition 3. It increased precision by `0.0446`, 50 ms F1 by `0.0151`, and onset-weighted F1 by `0.0113`, while reducing the mismatch rate by `0.0130`. Recall was `0.0111` lower.

## Instrument Selection Comparison

Automatic detection and the correct ensemble preset were compared on the same excerpts. Conditions with onset assistance use the drum mixing and note validation described above.

| Instrument selection | Pitch F1 @50 ms | Instrument-aware F1 @50 ms |
|---|---:|---:|
| Automatic detection with onset assistance | 0.5167 | 0.3563 |
| Correct ensemble preset without onset assistance | 0.5134 | 0.4322 |
| Correct ensemble preset with onset assistance | **0.5411** | **0.4653** |
| Correct ensemble preset with onset assistance, selected timbres only | 0.5409 | 0.4608 |

The correct ensemble preset with onset assistance exceeded automatic detection with onset assistance by `0.0244` in pitch F1 and `0.1090` in instrument-aware F1. Including related-family instrument candidates instead of selected timbres only changed pitch F1 by `0.0002` and instrument-aware F1 by `0.0045`.

## Conclusion

In this evaluation, source separation with component-specific instrument candidates produced higher pitch F1, recall, and onset-weighted F1 than direct transcription. The correct ensemble preset produced higher instrument-aware F1 than automatic detection.

Drum-assisted onset processing in condition 4 reduced the 95th-percentile onset error. Note validation reduced false detections after drum mixing. However, condition 4's 50 ms F1 and onset-weighted F1 were lower than condition 2, which used only source separation and component-specific instrument candidates. The difference between onset stability and recall should be considered for each use case.

## Limitations

- BabySlakh v2 uses synthesized audio and does not represent every type of room reverberation, performance noise, or microphone response found in recordings.
- The evaluation covers five excerpts and 100 seconds of audio.
- The evaluation is limited to MuScriptor medium with CUDA FP16 inference.
- The correct-preset condition uses dataset instrument metadata. A user-selected preset that differs from the performed ensemble will not produce the same result.

## Reproduction

1. Prepare BabySlakh v2.

   ```powershell
   .\scripts\prepare_babyslakh_benchmark.ps1 -Destination app/benchmark/public-data
   ```

2. Evaluate the four transcription conditions.

   ```powershell
   uv run python scripts/run_public_transcription_benchmark.py `
     --manifest scripts/benchmark_cases/babyslakh_v2.json `
     --dataset-root app/benchmark/public-data/babyslakh_16k `
     --model models/muscriptor/medium/model.safetensors `
     --stem-model models/bs-roformer/sw-fixed/BS-Rofo-SW-Fixed.ckpt `
     --backend CUDA --dtype float16 `
     --output-json docs/benchmarks/data/babyslakh-medium-fp16.json
   ```

3. Evaluate instrument selection.

   ```powershell
   uv run python scripts/run_routing_policy_benchmark.py `
     --manifest scripts/benchmark_cases/babyslakh_v2.json `
     --dataset-root app/benchmark/public-data/babyslakh_16k `
     --model models/muscriptor/medium/model.safetensors `
     --stem-model models/bs-roformer/sw-fixed/BS-Rofo-SW-Fixed.ckpt `
     --backend CUDA --dtype float16 `
     --work-dir app/benchmark/routing-results `
     --output-json docs/benchmarks/data/babyslakh-medium-fp16-routing-policy.json
   ```

The results are stored in the [transcription method results](benchmarks/data/babyslakh-medium-fp16.json) and [instrument selection results](benchmarks/data/babyslakh-medium-fp16-routing-policy.json).

## References

- [BabySlakh v2](https://doi.org/10.5281/zenodo.4603870)
- [Slakh](https://doi.org/10.5281/zenodo.4599666)
- [mir_eval](https://craffel.github.io/mir_eval/)
