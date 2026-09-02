from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class TempoEstimate(BaseModel):
    bpm: float = Field(ge=20.0, le=300.0)
    sample_rate: int = Field(alias="sampleRate")
    beat_offset_sec: float = Field(ge=0.0, alias="beatOffsetSec")


HOP_LENGTH = 512
INITIAL_TEMPO_BPM = 100.0
INITIAL_TEMPO_STD_BPM = 1.0
OCTAVE_PROMOTION_MIN_RECALL_GAIN = 0.4
OCTAVE_PROMOTION_MIN_SCORE_RATIO = 1.0
OCTAVE_PROMOTION_MIN_PERIODICITY_RATIO = 0.9
OCTAVE_PROMOTION_MAX_BPM = 220.0
REFINEMENT_WINDOW_BEATS = (8, 16, 32)
REFINEMENT_MAX_MISSING_BEAT_RATIO = 2.0
REFINEMENT_MAX_LOG2_DEVIATION = 0.12
REFINEMENT_MAD_MULTIPLIER = 2.5
REFINEMENT_MAX_PERIOD_DEVIATION_RATIO = 0.03
MEASURE_ENERGY_WINDOW_SEC = 0.07
MEASURE_LOW_FREQUENCY_MAX_HZ = 150.0
MEASURE_STFT_SIZE = 2048


def _nearest_reference_indices(
    np: Any,
    reference_frames: Any,
    query_frames: Any,
) -> tuple[Any, Any]:
    insertion = np.searchsorted(reference_frames, query_frames)
    left_indices = np.clip(insertion - 1, 0, reference_frames.size - 1)
    right_indices = np.clip(insertion, 0, reference_frames.size - 1)
    left_distances = np.abs(query_frames - reference_frames[left_indices])
    right_distances = np.abs(query_frames - reference_frames[right_indices])
    use_right = right_distances < left_distances
    nearest_indices = np.where(use_right, right_indices, left_indices)
    return nearest_indices, np.minimum(left_distances, right_distances)


def _tempo_candidate_score(
    librosa: Any,
    np: Any,
    onset_envelope: Any,
    onset_frames: Any,
    onset_strengths: Any,
    sample_rate: int,
    bpm: float,
) -> tuple[float, float, Any]:
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        hop_length=HOP_LENGTH,
        bpm=bpm,
        trim=False,
    )
    beat_frames = np.asarray(beat_frames, dtype=int)
    if beat_frames.size == 0:
        return 0.0, 0.0, beat_frames

    tolerance_sec = min(0.09, (60.0 / bpm) * 0.18)
    tolerance_frames = max(
        1,
        round(tolerance_sec * sample_rate / HOP_LENGTH),
    )
    _, onset_distances = _nearest_reference_indices(
        np,
        beat_frames,
        onset_frames,
    )
    recall = float(
        onset_strengths[onset_distances <= tolerance_frames].sum()
        / onset_strengths.sum()
    )

    nearest_onsets, beat_distances = _nearest_reference_indices(
        np,
        onset_frames,
        beat_frames,
    )
    matched_strengths = np.where(
        beat_distances <= tolerance_frames,
        onset_strengths[nearest_onsets],
        0.0,
    )
    precision = float(matched_strengths.mean())
    if precision + recall == 0:
        return 0.0, recall, beat_frames
    return (
        2 * precision * recall / (precision + recall),
        recall,
        beat_frames,
    )


def _periodicity_ratio(
    librosa: Any,
    np: Any,
    onset_envelope: Any,
    sample_rate: int,
    base_bpm: float,
    promoted_bpm: float,
) -> float:
    base_lag = sample_rate * 60.0 / (HOP_LENGTH * base_bpm)
    promoted_lag = sample_rate * 60.0 / (HOP_LENGTH * promoted_bpm)
    max_lag = max(base_lag, promoted_lag)
    autocorrelation = np.asarray(
        librosa.autocorrelate(
            onset_envelope,
            max_size=max(4, math.ceil(max_lag) + 2),
        ),
        dtype=float,
    )

    def peak(lag: float) -> float:
        center = round(lag)
        start = max(1, center - 1)
        stop = min(autocorrelation.size, center + 2)
        if start >= stop:
            return 0.0
        return float(np.max(autocorrelation[start:stop]))

    base_strength = peak(base_lag)
    if base_strength <= 0:
        return 0.0
    return peak(promoted_lag) / base_strength


def _weighted_median(np: Any, values: Any, weights: Any) -> float:
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    midpoint = float(sorted_weights.sum()) * 0.5
    index = int(
        min(
            sorted_values.size - 1,
            np.searchsorted(np.cumsum(sorted_weights), midpoint),
        )
    )
    return float(sorted_values[index])


def _refine_fixed_bpm(
    librosa: Any,
    np: Any,
    beat_frames: Any,
    sample_rate: int,
    candidate_bpm: float,
) -> float:
    if beat_frames.size < 4:
        return candidate_bpm
    beat_times = np.asarray(
        librosa.frames_to_time(
            beat_frames,
            sr=sample_rate,
            hop_length=HOP_LENGTH,
        ),
        dtype=float,
    )
    expected_period = 60.0 / candidate_bpm
    beat_steps = np.maximum(
        1,
        np.rint(np.diff(beat_times) / expected_period).astype(int),
    )
    beat_indices = np.concatenate(([0], np.cumsum(beat_steps)))
    local_periods = []
    local_weights = []
    for window_beats in REFINEMENT_WINDOW_BEATS:
        if beat_times.size <= window_beats:
            continue
        index_spans = (
            beat_indices[window_beats:] - beat_indices[:-window_beats]
        )
        periods = (
            beat_times[window_beats:] - beat_times[:-window_beats]
        ) / index_spans
        valid = (
            (periods > 0)
            & (
                index_spans
                <= window_beats * REFINEMENT_MAX_MISSING_BEAT_RATIO
            )
            & (
                np.abs(np.log2(periods / expected_period))
                <= REFINEMENT_MAX_LOG2_DEVIATION
            )
        )
        local_periods.extend(periods[valid])
        local_weights.extend(index_spans[valid])

    if not local_periods:
        return candidate_bpm

    periods = np.asarray(local_periods, dtype=float)
    weights = np.asarray(local_weights, dtype=float)
    median_period = _weighted_median(np, periods, weights)
    period_deviations = np.abs(periods - median_period)
    median_absolute_deviation = _weighted_median(
        np,
        period_deviations,
        weights,
    )
    frame_duration = HOP_LENGTH / sample_rate
    inlier_tolerance = min(
        max(
            frame_duration / min(REFINEMENT_WINDOW_BEATS),
            REFINEMENT_MAD_MULTIPLIER
            * 1.4826
            * median_absolute_deviation,
        ),
        expected_period * REFINEMENT_MAX_PERIOD_DEVIATION_RATIO,
    )
    stable = period_deviations <= inlier_tolerance
    if not np.any(stable):
        return candidate_bpm

    refined_period = float(
        np.average(periods[stable], weights=weights[stable])
    )
    if refined_period <= 0:
        return candidate_bpm
    refined_bpm = 60.0 / refined_period
    if not 20.0 <= refined_bpm <= 300.0:
        return candidate_bpm
    if abs(math.log2(refined_bpm / candidate_bpm)) > 0.12:
        return candidate_bpm
    return refined_bpm


def _estimate_fixed_tempo(
    librosa: Any,
    np: Any,
    onset_envelope: Any,
    sample_rate: int,
) -> tuple[float, Any]:
    tempo_value = librosa.feature.tempo(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        hop_length=HOP_LENGTH,
        start_bpm=INITIAL_TEMPO_BPM,
        std_bpm=INITIAL_TEMPO_STD_BPM,
        max_tempo=300.0,
        aggregate=np.mean,
    )
    initial_bpm = float(np.asarray(tempo_value).reshape(-1)[0])
    if initial_bpm <= 0:
        raise ValueError("BPMを推定できませんでした")

    onset_frames = np.asarray(
        librosa.onset.onset_detect(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            hop_length=HOP_LENGTH,
            backtrack=False,
            units="frames",
            normalize=True,
        ),
        dtype=int,
    )
    if onset_frames.size == 0:
        raise ValueError("拍として評価できるオンセットがありません")
    onset_strengths = np.maximum(
        0.0,
        np.asarray(onset_envelope, dtype=float)[onset_frames],
    )
    maximum_strength = float(onset_strengths.max())
    if maximum_strength <= 0:
        raise ValueError("拍として評価できるオンセットがありません")
    onset_strengths /= maximum_strength

    best_bpm = initial_bpm
    best_score, best_recall, best_beats = _tempo_candidate_score(
        librosa,
        np,
        onset_envelope,
        onset_frames,
        onset_strengths,
        sample_rate,
        initial_bpm,
    )
    double_bpm = initial_bpm * 2.0
    if double_bpm <= OCTAVE_PROMOTION_MAX_BPM:
        double_score, double_recall, double_beats = _tempo_candidate_score(
            librosa,
            np,
            onset_envelope,
            onset_frames,
            onset_strengths,
            sample_rate,
            double_bpm,
        )
        explains_more_onsets = (
            double_recall >= best_recall + OCTAVE_PROMOTION_MIN_RECALL_GAIN
        )
        retains_enough_confidence = (
            double_score >= best_score * OCTAVE_PROMOTION_MIN_SCORE_RATIO
        )
        retains_periodicity = (
            _periodicity_ratio(
                librosa,
                np,
                onset_envelope,
                sample_rate,
                best_bpm,
                double_bpm,
            )
            >= OCTAVE_PROMOTION_MIN_PERIODICITY_RATIO
        )
        if (
            explains_more_onsets
            and retains_enough_confidence
            and retains_periodicity
        ):
            best_bpm = double_bpm
            best_beats = double_beats

    if best_beats.size == 0:
        raise ValueError("拍を追跡できませんでした")
    return (
        _refine_fixed_bpm(
            librosa,
            np,
            best_beats,
            sample_rate,
            best_bpm,
        ),
        best_beats,
    )


def _fit_beat_grid_phase(
    np: Any,
    beat_times: Any,
    beat_period_sec: float,
) -> float:
    times = np.asarray(beat_times, dtype=float)
    if times.size == 0:
        return 0.0
    beat_steps = np.maximum(
        1,
        np.rint(np.diff(times) / beat_period_sec).astype(int),
    )
    beat_indices = np.concatenate(([0], np.cumsum(beat_steps)))
    intercepts = times - beat_indices * beat_period_sec
    return float(np.median(intercepts) % beat_period_sec)


def _normalize_measure_feature(np: Any, values: Any) -> Any:
    feature = np.asarray(values, dtype=float)
    if feature.size == 0:
        return feature
    median = float(np.median(feature))
    upper = float(np.percentile(feature, 90))
    if upper <= median:
        return np.zeros_like(feature)
    return np.clip((feature - median) / (upper - median), 0.0, 2.0)


def _select_measure_offset(
    np: Any,
    *,
    grid_phase_sec: float,
    grid_period_sec: float,
    slots_per_measure: int,
    first_beat_grid_index: int,
    low_frequency_energy_strengths: Any,
) -> float:
    low_frequency_energy = _normalize_measure_feature(
        np,
        low_frequency_energy_strengths,
    )
    grid_indices = np.arange(low_frequency_energy.size)
    preferred_slot = first_beat_grid_index % slots_per_measure
    scores = []
    for slot in range(slots_per_measure):
        values = low_frequency_energy[
            grid_indices % slots_per_measure == slot
        ]
        if values.size == 0:
            score = 0.0
        else:
            score = float(np.mean(values))
        scores.append(score)
    selected_slot = max(
        range(slots_per_measure),
        key=lambda slot: (scores[slot], slot == preferred_slot),
    )
    measure_period_sec = grid_period_sec * slots_per_measure
    return float(
        (grid_phase_sec + selected_slot * grid_period_sec) % measure_period_sec
    )


def _peak_strengths_near_frames(
    np: Any,
    envelope: Any,
    frames: Any,
    radius_frames: int,
) -> Any:
    values = np.asarray(envelope, dtype=float)
    return np.asarray(
        [
            float(
                np.max(
                    values[
                        max(0, frame - radius_frames) : min(
                            values.size,
                            frame + radius_frames + 1,
                        )
                    ]
                )
            )
            for frame in frames
        ],
        dtype=float,
    )


def _estimate_measure_offset(
    librosa: Any,
    np: Any,
    audio: Any,
    sample_rate: int,
    beat_times: Any,
    bpm: float,
    numerator: int,
    denominator: int,
) -> float:
    quarter_note_period_sec = 60.0 / bpm
    time_signature_beat_period_sec = (
        quarter_note_period_sec * 4.0 / denominator
    )
    grid_period_sec = min(
        quarter_note_period_sec,
        time_signature_beat_period_sec,
    )
    measure_period_sec = time_signature_beat_period_sec * numerator
    slots_per_measure = round(measure_period_sec / grid_period_sec)
    beat_grid_phase_sec = _fit_beat_grid_phase(
        np,
        beat_times,
        quarter_note_period_sec,
    )
    grid_phase_sec = beat_grid_phase_sec % grid_period_sec
    duration_sec = len(audio) / sample_rate
    grid_times = np.arange(grid_phase_sec, duration_sec, grid_period_sec)
    if grid_times.size == 0:
        return 0.0
    magnitude_spectrogram = np.abs(
        librosa.stft(
            audio,
            n_fft=MEASURE_STFT_SIZE,
            hop_length=HOP_LENGTH,
        )
    )
    frequencies = librosa.fft_frequencies(
        sr=sample_rate,
        n_fft=MEASURE_STFT_SIZE,
    )
    low_frequency_band = frequencies < MEASURE_LOW_FREQUENCY_MAX_HZ
    low_frequency_energy_envelope = np.log1p(
        np.mean(magnitude_spectrogram[low_frequency_band] ** 2, axis=0)
    )
    grid_frames = np.clip(
        np.rint(grid_times * sample_rate / HOP_LENGTH).astype(int),
        0,
        max(0, len(low_frequency_energy_envelope) - 1),
    )
    energy_radius_frames = max(
        1,
        round(
            MEASURE_ENERGY_WINDOW_SEC * sample_rate / HOP_LENGTH
        ),
    )
    first_beat_grid_index = round(
        (float(beat_times[0]) - grid_phase_sec) / grid_period_sec
    )
    return _select_measure_offset(
        np,
        grid_phase_sec=grid_phase_sec,
        grid_period_sec=grid_period_sec,
        slots_per_measure=slots_per_measure,
        first_beat_grid_index=first_beat_grid_index,
        low_frequency_energy_strengths=_peak_strengths_near_frames(
            np,
            low_frequency_energy_envelope,
            grid_frames,
            energy_radius_frames,
        ),
    )


def estimate_tempo(
    path: Path,
    *,
    numerator: int,
    denominator: int,
) -> TempoEstimate:
    """複数テンポ候補を全曲のオンセットへ照合し、一定BPMを推定する。"""

    try:
        import librosa
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("BPM推定にはlibrosaが必要です") from exc

    audio, sample_rate = librosa.load(path, sr=22050, mono=True)
    if audio.size == 0:
        raise ValueError("音源に解析可能なサンプルがありません")
    onset_envelope = librosa.onset.onset_strength(
        y=audio,
        sr=sample_rate,
        hop_length=HOP_LENGTH,
        aggregate=np.median,
    )
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        onset_envelope,
        sample_rate,
    )
    if not 20.0 <= bpm <= 300.0:
        raise ValueError(f"BPM推定値が範囲外です: {bpm}")
    beat_times = librosa.frames_to_time(
        beats,
        sr=sample_rate,
        hop_length=HOP_LENGTH,
    )
    reported_bpm = round(bpm, 1)
    beat_offset_sec = _estimate_measure_offset(
        librosa,
        np,
        audio,
        sample_rate,
        beat_times,
        reported_bpm,
        numerator,
        denominator,
    )
    return TempoEstimate(
        bpm=reported_bpm,
        sampleRate=sample_rate,
        beatOffsetSec=round(beat_offset_sec, 4),
    )
