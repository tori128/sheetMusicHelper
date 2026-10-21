# MuScriptor Beat Analysis and Onset Correction Evaluation

[日本語](MUSCRIPTOR_EVALUATION.md)

## Scope

EarCopy Assist 0.1.6 using MuScriptor 0.4.0 was evaluated on 2026-10-21. See the [tempo, beat, and downbeat evaluation](TEMPO_DOWNBEAT_EVALUATION.en.md) for estimator comparisons and [transcription methods on a public dataset](../TRANSCRIPTION_METHOD_BENCHMARK.en.md) for onset correction with direct and separated transcription.

The environment was Windows, Python 3.11.15, PyTorch 2.5.1+cu121, NumPy 2.2.6, and Beat This! 1.1.0. Beat analysis ran on CPU; transcription ran on an NVIDIA GeForce RTX 3060 Laptop GPU in float16. The small, medium, large, and Beat This! final0 weights were unchanged.

## Beat Analysis

MuScriptor 0.4.0's `detect_grid` receives the explicitly specified local final0 checkpoint. `regularized_beats` corrects missed and extra beats, then a constant BPM is fitted to the corrected sequence. Meter is inferred from beat counts between detected downbeats. Non-steady recordings also return average BPM. The application's piano roll and exports use the same BPM throughout the recording.

The comparison used 50 development and 50 evaluation tracks from GTZAN mini, including a candidate switching to the legacy estimator. Selection criteria, metric tradeoffs, and the previously rejected recording are documented in the tempo evaluation.

## Onset Correction

Original-audio beat analysis is shared by each direct/separated transcription input and reference transcription used for pitch filtering. After common postprocessing, MuScriptor's `with_onset_delay` measures onset lag. Official conditions include at least 40 distinct onset times, concentration of at least 0.5, and absolute shift of at most 40 ms. Corrections crossing the audio origin retain note duration while clamping the start to zero.

The transcription cache stores events before correction, so reuse applies correction once. Stored per-input notes contain corrected times, which are reused for transcription-option recalculation. The evaluation followed the same note IDs before and after correction for each direct/separated condition over five excerpts.

## Records and Reproduction

The [beat-analysis JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json) and [onset-correction JSON](../benchmarks/data/muscriptor-application-onset-comparison.json) record track metrics, conditions, and model/audio SHA-256 values. `applicationCommitIsBase` identifies measurements including working-tree changes on the recorded commit. `applicationSourceSha256` identifies the executed application Python sources. Reproduction steps are provided in each evaluation document.
