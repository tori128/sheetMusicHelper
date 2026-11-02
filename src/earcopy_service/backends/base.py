from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, TypeAlias


@dataclass(frozen=True, slots=True)
class BackendCapabilities:
    name: str
    device: str
    dtypes: tuple[str, ...]
    available: bool
    unavailable_reason: str | None = None


@dataclass(frozen=True, slots=True)
class BackendNoteStart:
    event_index: int
    instrument_id: str
    pitch: int
    start_sec: float


@dataclass(frozen=True, slots=True)
class BackendNoteEnd:
    event_index: int
    end_sec: float


@dataclass(frozen=True, slots=True)
class BackendProgress:
    completed: int
    total: int


@dataclass(frozen=True, slots=True)
class BackendInvalidChunk:
    chunk_index: int
    start_sec: float
    end_sec: float
    reason: str


BackendEvent: TypeAlias = (
    BackendNoteStart | BackendNoteEnd | BackendProgress | BackendInvalidChunk
)


class TranscriptionBackend(Protocol):
    def capabilities(self) -> BackendCapabilities: ...

    def load(self, model_path: Path, dtype: str) -> None: ...

    def transcribe(
        self,
        audio_path: Path,
        instruments: list[str] | None,
        on_event: Callable[[BackendEvent], None],
        *,
        beam_size: Literal[1, 2] = 1,
        prelude_forcing: bool = True,
        batch_size: int = 1,
    ) -> None: ...

    def unload(self) -> None: ...
