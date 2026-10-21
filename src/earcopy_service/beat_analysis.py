from __future__ import annotations

import hashlib
import logging
import sys
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path

from muscriptor.utils.audio import load_audio
from muscriptor.utils.beats import (
    BeatDetectionError,
    BeatGrid,
    detect_grid as detect_beat_grid,
)

from .models import Note
from .torch_runtime import MODEL_INITIALIZATION_LOCK

BEAT_MODEL_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
BEAT_MODEL_BYTES = 81_058_141
_LOGGER = logging.getLogger(__name__)


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
        _LOGGER.info("Beat analysis did not identify enough beats: %s", exc)
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
