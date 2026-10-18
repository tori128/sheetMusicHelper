from __future__ import annotations

import hashlib
import logging
import sys
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from torch import Tensor
from muscriptor.utils.audio import load_audio
from muscriptor.utils.beats import (
    MAX_TEMPO_RESIDUAL,
    MIN_BEATS,
    BeatDetectionError,
    BeatGrid,
    infer_beats_per_bar,
)

from .models import Note
from .torch_runtime import MODEL_INITIALIZATION_LOCK

BEAT_MODEL_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
BEAT_MODEL_BYTES = 81_058_141
_LOGGER = logging.getLogger(__name__)


def fit_beat_grid(beats: np.ndarray, downbeats: np.ndarray) -> BeatGrid:
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    if len(beats) < MIN_BEATS:
        raise BeatDetectionError(f"Only {len(beats)} beats detected, need at least {MIN_BEATS}")
    intervals = np.diff(beats)
    if not np.all(np.isfinite(beats)) or np.any(intervals <= 0):
        raise BeatDetectionError("Beat times must be finite and strictly increasing")

    period = float(np.median(intervals))
    # Count missed beats as multiple steps and extra detections as zero steps.
    indices = np.concatenate(([0], np.cumsum(np.maximum(0, np.rint(intervals / period)))))
    centered_indices = indices - np.mean(indices)
    fit = least_squares(
        lambda parameters: beats - (parameters[0] * centered_indices + parameters[1]),
        [period, float(np.median(beats - period * centered_indices))],
        loss="soft_l1",
        f_scale=MAX_TEMPO_RESIDUAL * period,
    )
    period = float(fit.x[0])
    residuals = np.abs(beats - (period * centered_indices + fit.x[1]))
    median_residual = float(np.median(residuals))
    if not fit.success or period <= 0 or median_residual > MAX_TEMPO_RESIDUAL * period:
        raise BeatDetectionError(
            f"No consistent tempo: median beat residual {median_residual * 1000:.1f} ms"
        )
    _LOGGER.info(
        "Detected %.3f BPM from %d beats (median absolute residual %.1f ms)",
        60.0 / period, len(beats), median_residual * 1000,
    )
    return BeatGrid(
        bpm=60.0 / period,
        beats_per_bar=infer_beats_per_bar(beats, downbeats),
        first_downbeat=float(downbeats[0]) if len(downbeats) else float(beats[0]),
        beats=beats,
    )


def detect_beat_grid(waveform: Tensor, sample_rate: int, *, checkpoint: str, device: str) -> BeatGrid:
    from beat_this.inference import Audio2Beats

    if waveform.shape[-1] < sample_rate:
        raise BeatDetectionError("Audio is too short to detect a tempo")
    beats, downbeats = Audio2Beats(
        checkpoint_path=checkpoint, device=device, dbn=False,
    )(waveform.mean(dim=0).detach().cpu().numpy(), sample_rate)
    return fit_beat_grid(beats, downbeats)


def beat_model_path() -> Path:
    root = (
        Path(sys.executable).resolve().parent.parent
        if getattr(sys, "frozen", False)
        else Path(__file__).resolve().parents[2]
    )
    return root / "models" / "beat-this" / "final0.ckpt"


@lru_cache(maxsize=1)
def _verify_model(path: Path, size: int, modified_ns: int) -> None:
    del modified_ns
    if size != BEAT_MODEL_BYTES:
        raise ValueError("Beat This! final0のファイルサイズが一致しません")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != BEAT_MODEL_SHA256:
        raise ValueError("Beat This! final0のSHA-256が一致しません")


@lru_cache(maxsize=10)
def _analyze_audio(
    audio_path: Path,
    audio_size: int,
    audio_modified_ns: int,
    model_path: Path,
    model_size: int,
    model_modified_ns: int,
) -> BeatGrid | None:
    del audio_size, audio_modified_ns
    _verify_model(model_path, model_size, model_modified_ns)
    try:
        with MODEL_INITIALIZATION_LOCK:
            return detect_beat_grid(
                load_audio(audio_path, target_sr=16_000),
                16_000,
                checkpoint=str(model_path),
                device="cpu",
            )
    except BeatDetectionError as exc:
        _LOGGER.info("Beat analysis did not identify a constant tempo: %s", exc)
        return None


def analyze_beats(audio_path: Path) -> BeatGrid | None:
    path = audio_path.resolve(strict=True)
    model = beat_model_path()
    if not model.is_file():
        raise ValueError(f"拍解析モデルが見つかりません: {model}")
    audio_stat = path.stat()
    model_stat = model.stat()
    return _analyze_audio(
        path,
        audio_stat.st_size,
        audio_stat.st_mtime_ns,
        model,
        model_stat.st_size,
        model_stat.st_mtime_ns,
    )


def correct_note_timing(
    notes: Sequence[Note],
    grid: BeatGrid | None,
) -> tuple[list[Note], float]:
    if grid is None or not notes:
        return list(notes), 0.0
    measured = grid.with_onset_delay([note.raw_start_sec for note in notes])
    delay = measured.onset_delay or 0.0
    corrected = []
    for note in notes:
        # Preserve note durations when a correction reaches the audio origin.
        shift = max(-min(note.raw_start_sec, note.start_sec), -delay)
        corrected.append(
            note.model_copy(update={
                "raw_start_sec": note.raw_start_sec + shift,
                "raw_end_sec": note.raw_end_sec + shift,
                "start_sec": note.start_sec + shift,
                "end_sec": note.end_sec + shift,
            })
        )
    return corrected, delay
