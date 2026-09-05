# Public Tempo, Beat, and Downbeat Evaluation

[日本語](TEMPO_DOWNBEAT_EVALUATION.md)

## Overview

EarCopy Assist tempo, beat, and downbeat estimation was evaluated with the public GTZAN mini dataset and Beat This! Annotations v1.1. On 50 tracks excluded from parameter selection, the proportion within 4% BPM error was 0.7200, beat macro F1 was 0.7651, and downbeat macro F1 was 0.2665.

## Evaluation Data

The evaluation used 100 30-second tracks from [GTZAN mini](https://github.com/TempoBeatDownbeat/gtzan_mini) and beat and downbeat annotations from [Beat This! Annotations v1.1](https://github.com/CPJKU/beat_this_annotations/tree/v1.1/gtzan). The reference contains 5,719 beats. The time-signature labels comprise 95 tracks in 4, four tracks in 3, and one track in 2.

Within each genre, the 50 tracks at even filename positions were used for parameter selection and the 50 tracks at odd filename positions were used for evaluation. The evaluation tracks were excluded from condition and threshold selection.

| Dataset | Revision |
|---|---|
| GTZAN mini | `a61439e86c13037011fde8e0f0743ec55c50bce3` |
| Beat This! Annotations | `890407d158078527ab396b49fea3c8a83e5734ee` (`v1.1`) |

## Estimation Method

The public evaluation used Librosa and NumPy. The Librosa tempo prior has a 100 BPM initial value and a standard deviation of 1.0. The double-tempo candidate was selected when the onset-recall increase was at least 0.40, the candidate F1 ratio was at least 1.0, the onset-strength autocorrelation ratio was at least 0.90, and the candidate BPM was at most 220.

The September 6, 2026 correction compares 1.5 and 2 times the initial estimate and changes candidate selection to an onset-recall increase of at least 0.20, a candidate F1 ratio of at least 0.75, and an autocorrelation ratio of at least 0.75. The candidate BPM limit remains 220. Local recordings at 164, 172, and 173 BPM improve from 82.0, 86.0, and 86.3 BPM to 164.0, 172.0, and 173.0 BPM respectively. A compressed recording at 150 BPM also improves from 99.5 BPM to 150.0 BPM. These four recordings were used to adjust and validate the conditions. The public evaluation results below describe the earlier conditions; GTZAN mini accuracy after the correction has not been measured.

Downbeat estimation calculates energy below 150 Hz from a 2,048-point STFT. It takes the maximum value within 70 ms before or after each beat and calculates the mean for each beat position within the time signature. Band energy is scaled to 0 through 2 with the median at 0 and the 90th percentile at 1. The beat position with the highest mean is selected as the downbeat.

## Metrics

Reference BPM is calculated from the median interval between consecutive reference beats. Tempo metrics are the proportion of tracks whose absolute BPM error is within 4% of the reference and the median absolute percentage error.

Uniform beat and downbeat sequences are generated from the estimated BPM and downbeat position through the end of each track. Estimated and reference events within 70 ms are matched one-to-one in time order, and macro F1 is the mean of per-track F1 values. Beat evaluation uses every reference beat; downbeat evaluation uses reference beats labeled as beat position 1.

## Results

Results on the 50 tracks excluded from parameter selection are as follows.

| Metric | Result |
|---|---:|
| BPM error within 4% | 0.7200 |
| Median BPM absolute percentage error | 0.3517% |
| Beat macro F1 | 0.7651 |
| Downbeat macro F1 | 0.2665 |

Measurements are stored in the [evaluation-result JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json).

## Limitations

- Each evaluation track is 30 seconds, so the evaluation does not cover tempo changes within a track.
- Of the 100 tracks, 95 use a four-beat time signature; the combined number of tracks with two- and three-beat time signatures is five.
- Downbeat macro F1 is 0.2665. Review the estimate in the piano roll and, when required, select a note and run **小節先頭に設定 (Set as measure start)**.

## Reproduction

The following procedure evaluates the checked-out implementation. Record the estimation conditions when comparing its results with the recorded evaluation.

1. Obtain the evaluation audio and annotations and select the measured revisions.

   ```powershell
   git clone https://github.com/TempoBeatDownbeat/gtzan_mini app/benchmark/gtzan_mini
   git -C app/benchmark/gtzan_mini checkout a61439e86c13037011fde8e0f0743ec55c50bce3
   git clone https://github.com/CPJKU/beat_this_annotations app/benchmark/beat_this_annotations
   git -C app/benchmark/beat_this_annotations checkout 890407d158078527ab396b49fea3c8a83e5734ee
   ```

2. Evaluate all 100 tracks.

   ```powershell
   uv run python scripts/evaluate_tempo_downbeat.py `
     --audio-root app/benchmark/gtzan_mini/genres `
     --annotations-root app/benchmark/beat_this_annotations/gtzan/annotations/beats `
     --split all `
     --output app/benchmark/tempo-downbeat.json
   ```

3. To evaluate only the 50 tracks excluded from parameter selection, specify `--split evaluation`.
