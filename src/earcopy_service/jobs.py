from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from .audio import prepare_analysis_audio
from .backends import (
    BackendCapabilities,
    BackendEvent,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
    CpuMuscriptorBackend,
    CudaMuscriptorBackend,
    TranscriptionBackend,
)
from .models import Stem, Track
from .note_processing import NoteEndEvent, NoteEventAssembler, NoteStartEvent
from .stem_separation import SCNET_CACHE_VERSION, separate_four_stems

JobStatus = Literal[
    "waiting",
    "preparing_audio",
    "separating",
    "loading_model",
    "transcribing",
    "building_project",
    "completed",
    "failed",
    "cancelled",
]
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


class TranscriptionJobRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    audio_path: str = Field(alias="audioPath")
    model_path: str = Field(alias="modelPath")
    dtype: Literal["float32"] = "float32"
    backend: Literal["Auto", "CPU", "CUDA"] = "Auto"
    mode: Literal["direct", "four_stem"] = "direct"
    tracks: list[Track] = Field(min_length=1, max_length=16)


@dataclass(frozen=True, slots=True)
class PublishedEvent:
    sequence: int
    data: dict[str, Any]


@dataclass(slots=True)
class _Job:
    id: UUID
    request: TranscriptionJobRequest
    status: JobStatus = "waiting"
    events: list[PublishedEvent] = field(default_factory=list)
    cancel_requested: threading.Event = field(default_factory=threading.Event)
    condition: threading.Condition = field(default_factory=threading.Condition)


class _Cancelled(Exception):
    pass


class TranscriptionJobManager:
    def __init__(
        self,
        backend_factory: Callable[[], TranscriptionBackend] | None = None,
        backend_factories: Mapping[
            str, Callable[[], TranscriptionBackend]
        ] | None = None,
        audio_preparer: Callable[[Path], Path] | None = None,
        stem_separator: Callable[[Path, Path], list[Stem]] | None = None,
    ) -> None:
        if backend_factory is not None and backend_factories is not None:
            raise ValueError(
                "backend_factoryとbackend_factoriesは同時に指定できません"
            )
        if backend_factories is not None:
            self._backend_factories = dict(backend_factories)
        elif backend_factory is not None:
            self._backend_factories = {"CPU": backend_factory}
        else:
            self._backend_factories = {
                "CPU": CpuMuscriptorBackend,
                "CUDA": CudaMuscriptorBackend,
            }
        self._audio_preparer = audio_preparer or self._prepare_audio
        self._stem_separator = stem_separator or separate_four_stems
        self._jobs: dict[UUID, _Job] = {}
        self._lock = threading.Lock()

    def backend_capabilities(self) -> list[dict[str, str | bool]]:
        capabilities = {
            backend_id: self._probe_backend(backend_id)
            for backend_id in ("CUDA", "CPU")
        }
        selected = next(
            (
                backend_id
                for backend_id in ("CUDA", "CPU")
                if capabilities[backend_id].available
            ),
            None,
        )
        result: list[dict[str, str | bool]] = [
            {
                "id": "Auto",
                "available": selected is not None,
                "reason": (
                    f"{selected}を自動選択"
                    if selected is not None
                    else "利用できる推論バックエンドがありません"
                ),
            }
        ]
        for backend_id in ("CPU", "CUDA"):
            capability = capabilities[backend_id]
            result.append(
                {
                    "id": backend_id,
                    "available": capability.available,
                    "reason": (
                        capability.name
                        if capability.available
                        else capability.unavailable_reason
                        or "利用できません"
                    ),
                }
            )
        return result

    def _probe_backend(self, backend_id: str) -> BackendCapabilities:
        factory = self._backend_factories.get(backend_id)
        if factory is None:
            return BackendCapabilities(
                name=backend_id,
                device=backend_id.lower(),
                dtypes=(),
                available=False,
                unavailable_reason="この配布版には含まれていません",
            )
        try:
            return factory().capabilities()
        except NotImplementedError:
            return BackendCapabilities(
                name=backend_id,
                device=backend_id.lower(),
                dtypes=("float32",),
                available=True,
            )
        except Exception as exc:
            return BackendCapabilities(
                name=backend_id,
                device=backend_id.lower(),
                dtypes=(),
                available=False,
                unavailable_reason=str(exc),
            )

    def _resolve_backend(
        self, requested: Literal["Auto", "CPU", "CUDA"]
    ) -> tuple[str, TranscriptionBackend]:
        candidates = ("CUDA", "CPU") if requested == "Auto" else (requested,)
        reasons: list[str] = []
        for backend_id in candidates:
            capability = self._probe_backend(backend_id)
            if capability.available:
                factory = self._backend_factories[backend_id]
                return backend_id, factory()
            reasons.append(
                f"{backend_id}: {capability.unavailable_reason or '利用できません'}"
            )
        raise RuntimeError(" / ".join(reasons))

    @staticmethod
    def _prepare_audio(source: Path) -> Path:
        user_data = Path(os.getenv("EARCOPY_USER_DATA", "UserData"))
        return prepare_analysis_audio(source, user_data / "cache" / "audio")

    @staticmethod
    def _stem_cache_directory(source: Path) -> Path:
        import hashlib

        digest = hashlib.sha256()
        with source.open("rb") as audio:
            for chunk in iter(lambda: audio.read(1024 * 1024), b""):
                digest.update(chunk)
        user_data = Path(os.getenv("EARCOPY_USER_DATA", "UserData"))
        return (
            user_data
            / "cache"
            / "stems"
            / SCNET_CACHE_VERSION
            / digest.hexdigest()
        )

    def start(self, request: TranscriptionJobRequest) -> UUID:
        job = _Job(id=uuid4(), request=request)
        with self._lock:
            self._jobs[job.id] = job
        thread = threading.Thread(
            target=self._run,
            args=(job,),
            daemon=True,
            name=f"transcription-{job.id}",
        )
        thread.start()
        return job.id

    def cancel(self, job_id: UUID) -> JobStatus:
        job = self._get(job_id)
        job.cancel_requested.set()
        return job.status

    def status(self, job_id: UUID) -> JobStatus:
        return self._get(job_id).status

    def events(self, job_id: UUID) -> list[PublishedEvent]:
        job = self._get(job_id)
        with job.condition:
            return list(job.events)

    def wait_for_terminal(self, job_id: UUID, timeout: float = 10) -> JobStatus:
        job = self._get(job_id)
        deadline = time.monotonic() + timeout
        with job.condition:
            while job.status not in TERMINAL_STATUSES:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"採譜ジョブが完了しませんでした: {job_id}")
                job.condition.wait(remaining)
            return job.status

    def iter_sse(self, job_id: UUID, after_sequence: int = 0) -> Iterator[str]:
        job = self._get(job_id)
        cursor = after_sequence
        while True:
            with job.condition:
                available = [event for event in job.events if event.sequence > cursor]
                if not available and job.status not in TERMINAL_STATUSES:
                    job.condition.wait(timeout=15)
                    available = [
                        event for event in job.events if event.sequence > cursor
                    ]
                terminal = job.status in TERMINAL_STATUSES
            if not available:
                if terminal:
                    return
                yield ": keep-alive\n\n"
                continue
            for event in available:
                cursor = event.sequence
                yield (
                    f"id: {event.sequence}\n"
                    f"data: {json.dumps(event.data, ensure_ascii=False)}\n\n"
                )
            if terminal and cursor >= job.events[-1].sequence:
                return

    def _get(self, job_id: UUID) -> _Job:
        with self._lock:
            try:
                return self._jobs[job_id]
            except KeyError as exc:
                raise KeyError(f"採譜ジョブが見つかりません: {job_id}") from exc

    def _publish(self, job: _Job, data: dict[str, Any]) -> None:
        with job.condition:
            event = PublishedEvent(sequence=len(job.events) + 1, data=data)
            job.events.append(event)
            job.condition.notify_all()

    def _set_status(
        self,
        job: _Job,
        status: JobStatus,
        backend: str | None = None,
    ) -> None:
        with job.condition:
            job.status = status
            job.condition.notify_all()
        event = {"type": "state", "status": status}
        if backend is not None:
            event["backend"] = backend
        self._publish(job, event)

    def _run(self, job: _Job) -> None:
        backend: TranscriptionBackend | None = None
        resolved_backend: str | None = None
        all_track_ids = {
            track.instrument_id: track.id for track in job.request.tracks
        }

        def make_event_handler(
            assembler: NoteEventAssembler,
            input_index: int,
            input_count: int,
        ) -> Callable[[BackendEvent], None]:
            def on_event(event: BackendEvent) -> None:
                if job.cancel_requested.is_set():
                    raise _Cancelled
                if isinstance(event, BackendNoteStart):
                    assembler.feed(
                        NoteStartEvent(
                            event_index=event.event_index,
                            instrument_id=event.instrument_id,
                            pitch=event.pitch,
                            start_sec=event.start_sec,
                        )
                    )
                elif isinstance(event, BackendNoteEnd):
                    note = assembler.feed(
                        NoteEndEvent(
                            event_index=event.event_index,
                            end_sec=event.end_sec,
                        )
                    )
                    if note is None:
                        return
                    self._publish(
                        job,
                        {
                            "type": "note",
                            **note.model_dump(by_alias=True, mode="json"),
                        },
                    )
                elif isinstance(event, BackendProgress):
                    self._publish(
                        job,
                        {
                            "type": "progress",
                            "stage": "transcribing",
                            "completed": input_index * event.total + event.completed,
                            "total": input_count * event.total,
                        },
                    )

            return on_event

        try:
            resolved_backend, backend = self._resolve_backend(
                job.request.backend
            )
            if job.cancel_requested.is_set():
                raise _Cancelled
            self._set_status(job, "preparing_audio")
            analysis_audio = self._audio_preparer(Path(job.request.audio_path))
            if job.cancel_requested.is_set():
                raise _Cancelled
            transcription_inputs: list[tuple[Path, dict[str, UUID]]] = [
                (analysis_audio, all_track_ids)
            ]
            if job.request.mode == "four_stem":
                self._set_status(job, "separating")
                stems = self._stem_separator(
                    analysis_audio,
                    self._stem_cache_directory(analysis_audio),
                )
                for stem in stems:
                    self._publish(
                        job,
                        {
                            "type": "stem",
                            "stem": stem.model_dump(
                                by_alias=True,
                                mode="json",
                            ),
                        },
                    )
                categories = {
                    "drums": {"drums", "timpani", "chromatic_percussion"},
                    "bass": {"acoustic_bass", "electric_bass", "contrabass"},
                    "vocals": {"voice"},
                }
                assigned = set().union(*categories.values())
                stem_paths = {
                    stem.type: Path(stem.cache_path) for stem in stems
                }
                transcription_inputs = []
                for stem_name in ("drums", "bass", "vocals", "other"):
                    allowed = (
                        categories[stem_name]
                        if stem_name in categories
                        else set(all_track_ids) - assigned
                    )
                    track_ids = {
                        name: track_id
                        for name, track_id in all_track_ids.items()
                        if name in allowed
                    }
                    if track_ids:
                        transcription_inputs.append(
                            (stem_paths[stem_name], track_ids)
                        )
            if job.cancel_requested.is_set():
                raise _Cancelled
            self._set_status(job, "loading_model")
            backend.load(Path(job.request.model_path), job.request.dtype)
            if job.cancel_requested.is_set():
                raise _Cancelled
            self._set_status(job, "transcribing")
            for index, (audio_path, track_ids) in enumerate(transcription_inputs):
                assembler = NoteEventAssembler(track_ids)
                backend.transcribe(
                    audio_path,
                    list(track_ids),
                    make_event_handler(
                        assembler,
                        index,
                        len(transcription_inputs),
                    ),
                )
                assembler.discard_pending()
            self._set_status(job, "building_project")
            self._set_status(job, "completed", backend=resolved_backend)
        except _Cancelled:
            self._set_status(job, "cancelled")
        except Exception as exc:
            self._publish(
                job,
                {
                    "type": "error",
                    "message": str(exc),
                    "exceptionType": type(exc).__name__,
                },
            )
            self._set_status(job, "failed")
        finally:
            if backend is not None:
                backend.unload()
