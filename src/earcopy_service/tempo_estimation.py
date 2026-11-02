from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from .beat_analysis import analyze_beats


class TempoUnavailableError(ValueError):
    pass


class TempoEstimate(BaseModel):
    bpm: float = Field(ge=20.0, le=300.0)
    sample_rate: int = Field(alias="sampleRate")
    beat_offset_sec: float = Field(ge=0.0, alias="beatOffsetSec")
    beats_per_bar: int | None = Field(default=None, alias="beatsPerBar")


def estimate_tempo(
    path: Path,
    *,
    numerator: int,
    denominator: int,
) -> TempoEstimate:
    if not 1 <= numerator <= 12 or denominator not in {2, 4, 8, 16}:
        raise ValueError("拍子の指定が範囲外です")
    grid = analyze_beats(path)
    if grid is None:
        raise TempoUnavailableError("拍を十分に検出できませんでした。BPMと拍子を指定してください")
    if not 20.0 <= grid.bpm <= 300.0:
        raise ValueError(f"BPM推定値が範囲外です: {grid.bpm}")
    measure_duration = (60.0 / grid.bpm) * numerator * 4 / denominator
    return TempoEstimate(
        bpm=grid.bpm,
        sampleRate=16_000,
        beatOffsetSec=grid.first_downbeat % measure_duration,
        beatsPerBar=grid.beats_per_bar,
    )
