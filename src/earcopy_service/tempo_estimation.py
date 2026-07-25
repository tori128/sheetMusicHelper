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
TEMPO_CANDIDATE_FACTORS = (0.5, 2 / 3, 1.0, 1.5, 2.0)
OCTAVE_PROMOTION_MIN_RECALL_GAIN = 0.15
OCTAVE_PROMOTION_MIN_SCORE_RATIO = 0.75


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
    slope = float(np.polyfit(beat_indices, beat_times, 1)[0])
    if slope <= 0:
        return candidate_bpm
    refined_bpm = 60.0 / slope
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
        start_bpm=120.0,
        std_bpm=1.5,
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

    candidates = sorted(
        {
            initial_bpm * factor
            for factor in TEMPO_CANDIDATE_FACTORS
            if 20.0 <= initial_bpm * factor <= 300.0
        }
    )
    candidate_results = []
    for candidate in candidates:
        score, recall, beat_frames = _tempo_candidate_score(
            librosa,
            np,
            onset_envelope,
            onset_frames,
            onset_strengths,
            sample_rate,
            candidate,
        )
        candidate_results.append((candidate, score, recall, beat_frames))

    best_bpm, best_score, best_recall, best_beats = max(
        candidate_results,
        key=lambda result: result[1],
    )
    double_tempo_results = [
        result
        for result in candidate_results
        if 1.9 <= result[0] / best_bpm <= 2.1
    ]
    if double_tempo_results:
        double_bpm, double_score, double_recall, double_beats = max(
            double_tempo_results,
            key=lambda result: result[1],
        )
        explains_more_onsets = (
            double_recall >= best_recall + OCTAVE_PROMOTION_MIN_RECALL_GAIN
        )
        retains_enough_confidence = (
            double_score >= best_score * OCTAVE_PROMOTION_MIN_SCORE_RATIO
        )
        if explains_more_onsets and retains_enough_confidence:
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


def estimate_tempo(path: Path) -> TempoEstimate:
    """複数テンポ候補を全曲のオンセットへ照合し、固定BPMを推定する。"""

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
    period_sec = 60.0 / bpm
    beat_times = librosa.frames_to_time(
        beats,
        sr=sample_rate,
        hop_length=HOP_LENGTH,
    )
    phases = [float(time_sec) % period_sec for time_sec in beat_times]
    if phases:
        angle = math.atan2(
            sum(math.sin(2 * math.pi * phase / period_sec) for phase in phases),
            sum(math.cos(2 * math.pi * phase / period_sec) for phase in phases),
        )
        beat_offset_sec = (angle % (2 * math.pi)) * period_sec / (2 * math.pi)
    else:
        beat_offset_sec = 0.0
    return TempoEstimate(
        bpm=round(bpm, 1),
        sampleRate=sample_rate,
        beatOffsetSec=round(beat_offset_sec, 4),
    )
