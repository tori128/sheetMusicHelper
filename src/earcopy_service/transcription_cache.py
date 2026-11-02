from __future__ import annotations

import gzip
import hashlib
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from .backends import (
    BackendEvent,
    BackendInvalidChunk,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
    TranscriptionBackend,
)
from .cache_management import mark_cache_entry_used, prune_cache_entries

TRANSCRIPTION_CACHE_FORMAT_VERSION = 1
TRANSCRIPTION_DECODER_VERSION = "muscriptor-events-guard-v2"


@dataclass(frozen=True, slots=True)
class CachedTranscription:
    events: tuple[BackendEvent, ...]
    progress_total: int


class TranscriptionResultCache:
    """Persist successful backend events before track assignment."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._audio_hashes: dict[tuple[Path, int, int], str] = {}

    @staticmethod
    def _package_version() -> str:
        try:
            return version("muscriptor")
        except PackageNotFoundError:
            return "unknown"

    def key(
        self,
        *,
        audio_path: Path,
        model_path: Path,
        backend: str,
        dtype: str,
        instruments: list[str] | None,
        prelude_forcing: bool,
        batch_size: int,
    ) -> str | None:
        try:
            audio_path = audio_path.resolve(strict=True)
            model_path = model_path.resolve(strict=True)
            audio_stat = audio_path.stat()
            model_stat = model_path.stat()
            audio_identity = (
                audio_path,
                audio_stat.st_size,
                audio_stat.st_mtime_ns,
            )
            audio_sha256 = self._audio_hashes.get(audio_identity)
            if audio_sha256 is None:
                digest = hashlib.sha256()
                with audio_path.open("rb") as audio_file:
                    for chunk in iter(
                        lambda: audio_file.read(1024 * 1024),
                        b"",
                    ):
                        digest.update(chunk)
                audio_sha256 = digest.hexdigest()
                self._audio_hashes[audio_identity] = audio_sha256
        except OSError:
            return None

        inputs = {
            "formatVersion": TRANSCRIPTION_CACHE_FORMAT_VERSION,
            "decoderVersion": TRANSCRIPTION_DECODER_VERSION,
            "muscriptorVersion": self._package_version(),
            "audioSha256": audio_sha256,
            "modelPath": str(model_path),
            "modelSize": model_stat.st_size,
            "modelMtimeNs": model_stat.st_mtime_ns,
            "backend": backend,
            "dtype": dtype,
            "instruments": instruments,
            "preludeForcing": prelude_forcing,
            "batchSize": batch_size,
        }
        return hashlib.sha256(
            json.dumps(
                inputs,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()

    def load(self, key: str | None) -> CachedTranscription | None:
        if key is None:
            return None
        path = self._path(key)
        try:
            with gzip.open(path, "rt", encoding="utf-8") as cache_file:
                payload = json.load(cache_file)
            if payload.get("formatVersion") != TRANSCRIPTION_CACHE_FORMAT_VERSION:
                return None
            events = tuple(
                self._deserialize_event(event) for event in payload["events"]
            )
            progress_total = int(payload.get("progressTotal", 1))
            if progress_total <= 0:
                raise ValueError("invalid progress total")
            mark_cache_entry_used(path)
            prune_cache_entries(
                self._root.parent,
                kinds={self._root.name},
                protected_paths={path},
                protected_paths_count_toward_limit=True,
            )
            return CachedTranscription(events, progress_total)
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            return None

    def save(
        self,
        key: str | None,
        events: list[BackendEvent],
        progress_total: int,
    ) -> None:
        if key is None:
            return
        self._root.mkdir(parents=True, exist_ok=True)
        destination = self._path(key)
        temporary = destination.with_name(
            f".{destination.name}.{os.getpid()}.tmp"
        )
        payload = {
            "formatVersion": TRANSCRIPTION_CACHE_FORMAT_VERSION,
            "progressTotal": max(1, progress_total),
            "events": [self._serialize_event(event) for event in events],
        }
        try:
            with gzip.open(temporary, "wt", encoding="utf-8") as cache_file:
                json.dump(
                    payload,
                    cache_file,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            temporary.replace(destination)
            prune_cache_entries(
                self._root.parent,
                kinds={self._root.name},
                protected_paths={destination},
                protected_paths_count_toward_limit=True,
            )
        except OSError:
            return
        finally:
            temporary.unlink(missing_ok=True)

    def transcribe(
        self,
        *,
        key: str | None,
        backend: TranscriptionBackend,
        audio_path: Path,
        instruments: list[str] | None,
        prelude_forcing: bool,
        batch_size: int,
        on_event: Callable[[BackendEvent], None],
        cancel_check: Callable[[], bool],
        ensure_backend_loaded: Callable[[], None],
        on_cache_hit: Callable[[], None] | None = None,
    ) -> bool:
        cached = self.load(key)
        if cached is not None:
            if on_cache_hit is not None:
                on_cache_hit()
            for event in cached.events:
                if cancel_check():
                    return True
                on_event(event)
            on_event(
                BackendProgress(
                    completed=cached.progress_total,
                    total=cached.progress_total,
                )
            )
            return True

        ensure_backend_loaded()
        captured: list[BackendEvent] = []
        progress_total = 1

        def capture(event: BackendEvent) -> None:
            nonlocal progress_total
            on_event(event)
            if isinstance(event, BackendProgress):
                progress_total = max(progress_total, event.total)
                return
            captured.append(event)

        backend.transcribe(
            audio_path,
            instruments,
            capture,
            prelude_forcing=prelude_forcing,
            batch_size=batch_size,
        )
        if not cancel_check():
            self.save(key, captured, progress_total)
        return False

    def _path(self, key: str) -> Path:
        return self._root / f"{key}.json.gz"

    @staticmethod
    def _serialize_event(event: BackendEvent) -> dict[str, Any]:
        if isinstance(event, BackendNoteStart):
            return {
                "type": "noteStart",
                "eventIndex": event.event_index,
                "instrumentId": event.instrument_id,
                "pitch": event.pitch,
                "startSec": event.start_sec,
            }
        if isinstance(event, BackendNoteEnd):
            return {
                "type": "noteEnd",
                "eventIndex": event.event_index,
                "endSec": event.end_sec,
            }
        if isinstance(event, BackendInvalidChunk):
            return {
                "type": "invalidChunk",
                "chunkIndex": event.chunk_index,
                "startSec": event.start_sec,
                "endSec": event.end_sec,
                "reason": event.reason,
            }
        raise TypeError(f"unsupported cached event: {type(event).__name__}")

    @staticmethod
    def _deserialize_event(payload: dict[str, Any]) -> BackendEvent:
        event_type = payload["type"]
        if event_type == "noteStart":
            return BackendNoteStart(
                event_index=int(payload["eventIndex"]),
                instrument_id=str(payload["instrumentId"]),
                pitch=int(payload["pitch"]),
                start_sec=float(payload["startSec"]),
            )
        if event_type == "noteEnd":
            return BackendNoteEnd(
                event_index=int(payload["eventIndex"]),
                end_sec=float(payload["endSec"]),
            )
        if event_type == "invalidChunk":
            return BackendInvalidChunk(
                chunk_index=int(payload["chunkIndex"]),
                start_sec=float(payload["startSec"]),
                end_sec=float(payload["endSec"]),
                reason=str(payload["reason"]),
            )
        raise ValueError(f"unsupported cached event type: {event_type}")
