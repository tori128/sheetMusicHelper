from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import traceback
from collections import deque
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .audio import prepare_analysis_audio
from .backends import (
    BackendCapabilities,
    BackendEvent,
    BackendInvalidChunk,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
    CpuMuscriptorBackend,
    CudaMuscriptorBackend,
    MUSCRIPTOR_CHUNK_DURATION_SEC,
    TranscriptionBackend,
)
from .diagnostics import log_backend_event
from .instrument_routing import (
    InstrumentTrackRegistry,
    collapse_mapped_family_duplicates,
    expand_selected_instrument_families,
    transcription_candidate_ids,
)
from .models import Note, Stem, Track, TranscriptionPass
from .model_validation import ModelVariant
from .note_processing import (
    NoteEndEvent,
    NoteEventAssembler,
    NoteStartEvent,
    filter_notes_after_audio_tail,
    filter_pathological_note_chains,
    filter_timing_guide_notes,
)
from .stem_separation import (
    StemSeparationCancelled,
    configured_stem_cache_version,
    mix_bass_with_highpassed_drums_for_transcription,
    mix_stems_for_transcription,
    separation_output_stems,
    separate_sources,
)
from .transcription_inputs import (
    PITCHED_TIMING_GUIDE_INPUTS,
    TIMING_GUIDE_NOTE_FILTER_INPUTS,
    SeparatedInputSettings,
    SeparatedTranscriptionInputName,
    TranscriptionInputBuilder,
    active_timing_guide_inputs,
    default_pitched_timing_guide_gains,
)
from .transcription_cache import TranscriptionResultCache
from .transcription_postprocessing import postprocess_transcription_notes
from .transcription_profiles import (
    TranscriptionProfile,
    inference_settings_for_profile,
)
from .velocity_estimation import (
    StemAmplitudeEnvelope,
    assign_velocities_from_stem_amplitude,
)

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
MAX_RETAINED_TERMINAL_JOBS = 4


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class TranscriptionJobRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    audio_path: str = Field(alias="audioPath")
    model_path: str = Field(alias="modelPath")
    dtype: Literal["float32", "float16"] = "float16"
    backend: Literal["Auto", "CPU", "CUDA"] = "Auto"
    mode: Literal["direct", "separated"] = "direct"
    model_variant: ModelVariant = Field(default="large", alias="modelVariant")
    transcription_profile: TranscriptionProfile = Field(
        default="high_accuracy",
        alias="transcriptionProfile",
    )
    instrument_selection_mode: Literal["fixed", "automatic"] = Field(
        default="fixed",
        alias="instrumentSelectionMode",
    )
    drum_onset_guide: bool = Field(default=False, alias="drumOnsetGuide")
    timing_guide_note_filter: bool = Field(
        default=False,
        alias="timingGuideNoteFilter",
    )
    velocity_from_stem_amplitude: bool = Field(
        default=True,
        alias="velocityFromStemAmplitude",
    )
    transcription_input_names: frozenset[
        SeparatedTranscriptionInputName
    ] | None = Field(
        default=None,
        alias="transcriptionInputNames",
        min_length=1,
        max_length=6,
    )
    transcription_input_pass: Literal[
        "all",
        "timing_reference_only",
    ] = Field(default="all", alias="transcriptionInputPass")
    tracks: list[Track] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def validate_tracks_for_selection_mode(self) -> TranscriptionJobRequest:
        if self.instrument_selection_mode == "fixed" and not self.tracks:
            raise ValueError("fixed instrument selection requires tracks")
        if (
            self.mode != "separated"
            and self.transcription_input_names is not None
        ):
            raise ValueError(
                "transcriptionInputNames is available only in separated mode"
            )
        if self.transcription_input_pass == "timing_reference_only":
            if self.mode != "separated":
                raise ValueError(
                    "timing_reference_only is available only in separated mode"
                )
            if not self.transcription_input_names:
                raise ValueError(
                    "timing_reference_only requires transcriptionInputNames"
                )
            unsupported = (
                self.transcription_input_names
                - TIMING_GUIDE_NOTE_FILTER_INPUTS
            )
            if unsupported:
                raise ValueError(
                    "timing_reference_only does not support inputs: "
                    f"{','.join(sorted(unsupported))}"
                )
        return self


@dataclass(frozen=True, slots=True)
class PublishedEvent:
    sequence: int
    data: dict[str, Any]


@dataclass(frozen=True, slots=True)
class TranscriptionMethodPolicy:
    """Internal switches used to measure transcription methods independently."""

    timing_guide_inputs: frozenset[str] = PITCHED_TIMING_GUIDE_INPUTS
    timing_guide_gains: Mapping[str, float] = field(
        default_factory=default_pitched_timing_guide_gains
    )
    reject_timing_guide_events: bool = True
    expand_fixed_instrument_families: bool = True
    collapse_fixed_instrument_family_duplicates: bool = True


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
        stem_separator: Callable[
            [
                Path,
                Path,
                Path | None,
                Callable[[], bool],
                Callable[[int, int], None],
            ],
            list[Stem],
        ]
        | None = None,
        stem_mixer: Callable[
            [list[Path], Path, Callable[[], bool]],
            Path,
        ]
        | None = None,
        weighted_stem_mixer: Callable[
            [list[Path], list[float], Path, Callable[[], bool]],
            Path,
        ]
        | None = None,
        bass_timing_guide_mixer: Callable[
            [Path, Path, float, Path, Callable[[], bool]],
            Path,
        ]
        | None = None,
        transcription_method_policy: TranscriptionMethodPolicy | None = None,
        transcription_cache: TranscriptionResultCache | None = None,
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
        self._stem_separator = stem_separator or separate_sources
        self._stem_mixer = stem_mixer or mix_stems_for_transcription
        self._weighted_stem_mixer = weighted_stem_mixer or (
            lambda sources, gains, output, cancel: mix_stems_for_transcription(
                sources,
                output,
                cancel,
                gains=gains,
            )
        )
        if bass_timing_guide_mixer is not None:
            self._bass_timing_guide_mixer = bass_timing_guide_mixer
        elif weighted_stem_mixer is not None:
            self._bass_timing_guide_mixer = (
                lambda bass, drums, gain, output, cancel: (
                    self._weighted_stem_mixer(
                        [bass, drums],
                        [1.0, gain],
                        output,
                        cancel,
                    )
                )
            )
        else:
            self._bass_timing_guide_mixer = (
                mix_bass_with_highpassed_drums_for_transcription
            )
        self._transcription_method_policy = (
            transcription_method_policy or TranscriptionMethodPolicy()
        )
        user_data = Path(os.getenv("EARCOPY_USER_DATA", "UserData"))
        self._transcription_cache = transcription_cache or TranscriptionResultCache(
            user_data / "cache" / "transcriptions"
        )
        self._jobs: dict[UUID, _Job] = {}
        self._terminal_job_ids: deque[UUID] = deque()
        self._lock = threading.Lock()
        self._execution_lock = threading.Lock()

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
        user_data = Path(os.getenv("EARCOPY_USER_DATA", "UserData"))
        return (
            user_data
            / "cache"
            / "stems"
            / configured_stem_cache_version()
            / _file_sha256(source)
        )

    def start(self, request: TranscriptionJobRequest) -> UUID:
        job = _Job(id=uuid4(), request=request)
        log_backend_event(
            "job",
            (
                f"id={job.id} queued mode={request.mode} "
                f"requested_backend={request.backend} tracks={len(request.tracks)}"
            ),
        )
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
        cursor = max(0, after_sequence)
        while True:
            with job.condition:
                available = job.events[cursor:]
                if not available and job.status not in TERMINAL_STATUSES:
                    job.condition.wait(timeout=15)
                    available = job.events[cursor:]
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
        log_backend_event(
            "job",
            (
                f"id={job.id} status={status}"
                + (f" backend={backend}" if backend is not None else "")
            ),
        )
        event = {"type": "state", "status": status}
        if backend is not None:
            event["backend"] = backend
        with job.condition:
            job.events.append(
                PublishedEvent(sequence=len(job.events) + 1, data=event)
            )
            job.status = status
            if status in TERMINAL_STATUSES:
                self._prune_terminal_jobs(job.id)
            job.condition.notify_all()

    def _run(self, job: _Job) -> None:
        with self._execution_lock:
            self._run_exclusive(job)

    def _run_exclusive(self, job: _Job) -> None:
        backend: TranscriptionBackend | None = None
        resolved_backend: str | None = None
        automatic_instruments = (
            job.request.instrument_selection_mode == "automatic"
        )
        method_policy = self._transcription_method_policy
        enabled_guide_inputs = active_timing_guide_inputs(
            method_policy.timing_guide_inputs,
            method_policy.timing_guide_gains,
        )

        def publish_track(track: Track) -> None:
            self._publish(
                job,
                {
                    "type": "track",
                    "track": track.model_dump(
                        by_alias=True,
                        mode="json",
                    ),
                },
            )

        track_registry = InstrumentTrackRegistry(
            job.request.tracks,
            automatic_instruments,
            publish_track,
        )
        all_track_ids = track_registry.track_ids

        def make_event_handler(
            assembler: NoteEventAssembler,
            input_index: int,
            input_count: int,
            assembled_notes: list[Note],
            invalid_chunks: list[BackendInvalidChunk],
            transcription_input_name: str,
            transcription_pass: Literal[
                "original_audio",
                "separated_audio",
                "drums_added_audio",
                "other_added_audio",
            ],
            input_pass_index: int,
            input_pass_count: int,
            on_progress: Callable[[], None] | None = None,
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
                    assembled_notes.append(note)
                elif isinstance(event, BackendProgress):
                    if on_progress is not None:
                        on_progress()
                    self._publish(
                        job,
                        {
                            "type": "progress",
                            "stage": "transcribing",
                            "completed": input_index * event.total + event.completed,
                            "total": input_count * event.total,
                            "transcriptionInputName": transcription_input_name,
                            "transcriptionPass": transcription_pass,
                            "inputPassIndex": input_pass_index,
                            "inputPassCount": input_pass_count,
                        },
                    )
                elif isinstance(event, BackendInvalidChunk):
                    invalid_chunks.append(event)

            return on_event

        try:
            resolved_backend, backend = self._resolve_backend(
                job.request.backend
            )
            model_dtype = (
                job.request.dtype
                if resolved_backend == "CUDA"
                else "float32"
            )
            log_backend_event(
                "job",
                (
                    f"id={job.id} model_dtype={model_dtype} "
                    f"requested_dtype={job.request.dtype}"
                ),
            )
            if job.cancel_requested.is_set():
                raise _Cancelled
            self._set_status(job, "preparing_audio")
            analysis_audio = self._audio_preparer(Path(job.request.audio_path))
            if job.cancel_requested.is_set():
                raise _Cancelled
            direct_track_ids = (
                all_track_ids
                if automatic_instruments
                else (
                    expand_selected_instrument_families(all_track_ids)
                    if method_policy.expand_fixed_instrument_families
                    else all_track_ids
                )
            )
            input_builder = TranscriptionInputBuilder(
                self._stem_mixer,
                self._weighted_stem_mixer,
                job.cancel_requested.is_set,
                self._bass_timing_guide_mixer,
            )
            timing_reference_only = (
                job.request.transcription_input_pass
                == "timing_reference_only"
            )
            transcription_inputs = [
                input_builder.direct(analysis_audio, direct_track_ids)
            ]
            if job.request.mode == "separated":
                self._set_status(job, "separating")
                separation_progress_total = 0

                def publish_separation_progress(
                    completed: int,
                    total: int,
                ) -> None:
                    nonlocal separation_progress_total
                    separation_progress_total = total
                    self._publish(
                        job,
                        {
                            "type": "progress",
                            "stage": "separating",
                            "completed": completed,
                            "total": total,
                        },
                    )

                try:
                    stems = self._stem_separator(
                        analysis_audio,
                        self._stem_cache_directory(analysis_audio),
                        None,
                        job.cancel_requested.is_set,
                        publish_separation_progress,
                    )
                except StemSeparationCancelled as exc:
                    raise _Cancelled from exc
                for stem in separation_output_stems(stems):
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
                try:
                    transcription_inputs = input_builder.separated(
                        stems,
                        job.request.tracks,
                        all_track_ids,
                        SeparatedInputSettings(
                            automatic_instruments=automatic_instruments,
                            drum_onset_guide=(
                                job.request.drum_onset_guide
                                and not timing_reference_only
                            ),
                            timing_guide_inputs=(
                                enabled_guide_inputs
                            ),
                            timing_guide_gains=method_policy.timing_guide_gains,
                            expand_fixed_instrument_families=(
                                method_policy.expand_fixed_instrument_families
                            ),
                            included_input_names=(
                                job.request.transcription_input_names
                            ),
                        ),
                    )
                except StemSeparationCancelled as exc:
                    raise _Cancelled from exc
            if job.cancel_requested.is_set():
                raise _Cancelled
            model_path = Path(job.request.model_path)
            inference_settings = inference_settings_for_profile(
                job.request.transcription_profile,
                job.request.model_variant,
                "CUDA" if resolved_backend == "CUDA" else "CPU",
            )
            backend_loaded = False
            transcription_started = False

            def mark_transcribing() -> None:
                nonlocal transcription_started
                if transcription_started:
                    return
                self._set_status(job, "transcribing")
                transcription_started = True

            def ensure_backend_loaded() -> None:
                nonlocal backend_loaded
                if backend_loaded:
                    return
                if not transcription_started:
                    self._set_status(job, "loading_model")
                backend.load(model_path, model_dtype)
                backend_loaded = True
                if job.cancel_requested.is_set():
                    raise _Cancelled
                mark_transcribing()

            effective_audio_end_cache: dict[Path, float | None] = {}
            amplitude_envelope_cache: dict[
                Path,
                StemAmplitudeEnvelope | None,
            ] = {}
            additional_passes_completed = 0
            timing_guide_filter_pass_count = sum(
                1
                for transcription_input in transcription_inputs
                if transcription_input.unmodified_audio_path is not None
            )
            progress_input_count = (
                len(transcription_inputs)
                + timing_guide_filter_pass_count
            )
            for index, transcription_input in enumerate(transcription_inputs):
                pitch_activity_cache: dict[Path, tuple[Any, Any] | None] = {}
                audio_path = transcription_input.audio_path
                track_ids = transcription_input.track_ids
                input_name = transcription_input.name
                evidence_paths = transcription_input.evidence_paths
                candidate_instrument_ids = transcription_candidate_ids(
                    track_ids,
                    input_name,
                    job.request.tracks,
                    job.request.drum_onset_guide
                    and input_name
                    in enabled_guide_inputs
                    and method_policy.reject_timing_guide_events,
                )
                model_instrument_ids = (
                    None
                    if automatic_instruments and input_name == "direct"
                    else candidate_instrument_ids
                )
                progress_input_index = index + additional_passes_completed
                input_pass_count = (
                    1
                    + int(transcription_input.unmodified_audio_path is not None)
                )
                if job.request.mode == "direct":
                    primary_transcription_pass = "original_audio"
                elif timing_reference_only:
                    primary_transcription_pass = "separated_audio"
                elif audio_path in evidence_paths.values():
                    primary_transcription_pass = "separated_audio"
                elif input_name == "drums":
                    primary_transcription_pass = "other_added_audio"
                else:
                    primary_transcription_pass = "drums_added_audio"

                def publish_input_result(
                    role: Literal[
                        "primary",
                        "timing_reference",
                    ],
                    transcription_pass: TranscriptionPass,
                    notes: list[Note],
                ) -> None:
                    self._publish(
                        job,
                        {
                            "type": "transcription_input_result",
                            "inputName": input_name,
                            "role": role,
                            "transcriptionPass": transcription_pass,
                            "notes": [
                                note.model_dump(by_alias=True, mode="json")
                                for note in notes
                            ],
                        },
                    )
                log_backend_event(
                    "job",
                    (
                        f"id={job.id} transcription_input={input_name} "
                        f"targets={','.join(track_ids)} "
                        "candidates="
                        f"{','.join(candidate_instrument_ids)} "
                        "conditioning="
                        f"{'auto' if model_instrument_ids is None else 'fixed'}"
                    ),
                )
                cache_key = self._transcription_cache.key(
                    audio_path=audio_path,
                    model_path=model_path,
                    backend=resolved_backend,
                    dtype=model_dtype,
                    instruments=model_instrument_ids,
                    prelude_forcing=inference_settings.prelude_forcing,
                    batch_size=inference_settings.batch_size,
                )
                assembler = NoteEventAssembler(
                    track_ids,
                    note_id_namespace=cache_key,
                )
                assembled_notes: list[Note] = []
                invalid_chunks: list[BackendInvalidChunk] = []
                previewed_notes: dict[UUID, Note] = {}

                def publish_direct_preview() -> None:
                    if job.request.mode != "direct":
                        return
                    preview_valid_notes = [
                        note
                        for note in assembled_notes
                        if not any(
                            note.raw_start_sec < invalid.end_sec
                            and note.raw_end_sec > invalid.start_sec
                            for invalid in invalid_chunks
                        )
                    ]
                    preview_tail_filtered = filter_notes_after_audio_tail(
                        preview_valid_notes,
                        evidence_paths,
                        effective_audio_end_cache,
                    )
                    preview_filtered = filter_pathological_note_chains(
                        preview_tail_filtered.notes,
                        evidence_paths,
                    ).notes
                    if (
                        not automatic_instruments
                        and method_policy
                        .collapse_fixed_instrument_family_duplicates
                    ):
                        preview_filtered, _ = collapse_mapped_family_duplicates(
                            preview_filtered,
                            track_registry.selected_instrument_by_track_id,
                        )

                    current_notes: dict[UUID, Note] = {}
                    for note in preview_filtered:
                        if not track_registry.ensure_published(
                            note.source_instrument_id
                        ):
                            continue
                        current_notes[note.id] = note
                        if previewed_notes.get(note.id) == note:
                            continue
                        self._publish(
                            job,
                            {
                                "type": "note",
                                **note.model_dump(by_alias=True, mode="json"),
                            },
                        )

                    removed_note_ids = sorted(
                        str(note_id)
                        for note_id in previewed_notes.keys()
                        - current_notes.keys()
                    )
                    if removed_note_ids:
                        self._publish(
                            job,
                            {
                                "type": "note_cleanup",
                                "removedNoteIds": removed_note_ids,
                            },
                        )
                    previewed_notes.clear()
                    previewed_notes.update(current_notes)

                cache_hit = self._transcription_cache.transcribe(
                    key=cache_key,
                    backend=backend,
                    audio_path=audio_path,
                    instruments=model_instrument_ids,
                    prelude_forcing=inference_settings.prelude_forcing,
                    batch_size=inference_settings.batch_size,
                    on_event=make_event_handler(
                        assembler,
                        progress_input_index,
                        progress_input_count,
                        assembled_notes,
                        invalid_chunks,
                        input_name,
                        primary_transcription_pass,
                        1,
                        input_pass_count,
                        publish_direct_preview,
                    ),
                    cancel_check=job.cancel_requested.is_set,
                    ensure_backend_loaded=ensure_backend_loaded,
                    on_cache_hit=mark_transcribing,
                )
                cache_state = "hit" if cache_hit else "miss"
                cache_key_prefix = cache_key[:12] if cache_key else "disabled"
                log_backend_event(
                    "job",
                    (
                        f"id={job.id} transcription_cache={cache_state} "
                        f"input={input_name} key={cache_key_prefix}"
                    ),
                )
                if job.cancel_requested.is_set():
                    raise _Cancelled
                pending_discarded = assembler.discard_pending()
                postprocessing = postprocess_transcription_notes(
                    assembled_notes,
                    invalid_chunks,
                    evidence_paths,
                    effective_audio_end_cache,
                    pitch_activity_cache,
                    missing_sustain_chunk_duration_sec=(
                        None
                        if inference_settings.prelude_forcing
                        else MUSCRIPTOR_CHUNK_DURATION_SEC
                    ),
                )
                published_notes = postprocessing.notes
                publish_input_result(
                    (
                        "timing_reference"
                        if timing_reference_only
                        else "primary"
                    ),
                    primary_transcription_pass,
                    postprocessing.notes,
                )
                timing_guide_unmodified_note_count: int | None = None
                timing_guide_note_discarded_count = 0
                timing_guide_note_merged_count = 0
                timing_guide_filter_cache_hit: bool | None = None
                if transcription_input.unmodified_audio_path is not None:
                    unmodified_audio_path = (
                        transcription_input.unmodified_audio_path
                    )
                    unmodified_assembler = NoteEventAssembler(track_ids)
                    unmodified_notes: list[Note] = []
                    unmodified_invalid_chunks: list[BackendInvalidChunk] = []
                    unmodified_cache_key = self._transcription_cache.key(
                        audio_path=unmodified_audio_path,
                        model_path=model_path,
                        backend=resolved_backend,
                        dtype=model_dtype,
                        instruments=model_instrument_ids,
                        prelude_forcing=inference_settings.prelude_forcing,
                        batch_size=inference_settings.batch_size,
                    )
                    timing_guide_filter_cache_hit = (
                        self._transcription_cache.transcribe(
                            key=unmodified_cache_key,
                            backend=backend,
                            audio_path=unmodified_audio_path,
                            instruments=model_instrument_ids,
                            prelude_forcing=inference_settings.prelude_forcing,
                            batch_size=inference_settings.batch_size,
                            on_event=make_event_handler(
                                unmodified_assembler,
                                progress_input_index + 1,
                                progress_input_count,
                                unmodified_notes,
                                unmodified_invalid_chunks,
                                input_name,
                                "separated_audio",
                                2,
                                input_pass_count,
                            ),
                            cancel_check=job.cancel_requested.is_set,
                            ensure_backend_loaded=ensure_backend_loaded,
                            on_cache_hit=mark_transcribing,
                        )
                    )
                    if job.cancel_requested.is_set():
                        raise _Cancelled
                    unmodified_assembler.discard_pending()
                    unmodified_postprocessing = postprocess_transcription_notes(
                        unmodified_notes,
                        unmodified_invalid_chunks,
                        evidence_paths,
                        effective_audio_end_cache,
                        pitch_activity_cache,
                        missing_sustain_chunk_duration_sec=(
                            None
                            if inference_settings.prelude_forcing
                            else MUSCRIPTOR_CHUNK_DURATION_SEC
                        ),
                    )
                    timing_guide_unmodified_note_count = len(
                        unmodified_postprocessing.notes
                    )
                    publish_input_result(
                        "timing_reference",
                        "separated_audio",
                        unmodified_postprocessing.notes,
                    )
                    if job.request.timing_guide_note_filter:
                        timing_guide_filter = filter_timing_guide_notes(
                            published_notes,
                            unmodified_postprocessing.notes,
                        )
                        published_notes = timing_guide_filter.notes
                        timing_guide_note_discarded_count = (
                            timing_guide_filter.discarded_count
                        )
                        timing_guide_note_merged_count = (
                            timing_guide_filter.merged_count
                        )
                    additional_passes_completed += 1
                    unmodified_cache_state = (
                        "hit" if timing_guide_filter_cache_hit else "miss"
                    )
                    unmodified_cache_key_prefix = (
                        unmodified_cache_key[:12]
                        if unmodified_cache_key
                        else "disabled"
                    )
                    log_backend_event(
                        "job",
                        (
                            f"id={job.id} timing_guide_note_filter "
                            f"input={input_name} "
                            f"guided={len(postprocessing.notes)} "
                            "unmodified="
                            f"{timing_guide_unmodified_note_count} "
                            "discarded="
                            f"{timing_guide_note_discarded_count} "
                            f"merged={timing_guide_note_merged_count} "
                            f"cache={unmodified_cache_state} "
                            f"key={unmodified_cache_key_prefix}"
                        ),
                    )
                mapped_duplicate_discarded = 0
                if (
                    not automatic_instruments
                    and method_policy
                    .collapse_fixed_instrument_family_duplicates
                ):
                    (
                        published_notes,
                        mapped_duplicate_discarded,
                    ) = collapse_mapped_family_duplicates(
                        published_notes,
                        track_registry.selected_instrument_by_track_id,
                    )
                if (
                    job.request.mode == "separated"
                    and job.request.velocity_from_stem_amplitude
                ):
                    velocity_assignment = (
                        assign_velocities_from_stem_amplitude(
                            published_notes,
                            evidence_paths,
                            amplitude_envelope_cache,
                        )
                    )
                    published_notes = velocity_assignment.notes
                    log_backend_event(
                        "job",
                        (
                            f"id={job.id} stem_amplitude_velocity "
                            f"input={input_name} "
                            f"measured={velocity_assignment.measured_count} "
                            "unavailable="
                            f"{','.join(map(str, velocity_assignment.unavailable_paths))}"
                        ),
                    )
                notes_for_publication = (
                    [] if timing_reference_only else published_notes
                )
                final_published_note_ids: set[UUID] = set()
                for note in notes_for_publication:
                    if not track_registry.ensure_published(
                        note.source_instrument_id
                    ):
                        log_backend_event(
                            "job",
                            (
                                f"id={job.id} automatic_track_limit "
                                f"instrument={note.source_instrument_id}"
                            ),
                        )
                        continue
                    final_published_note_ids.add(note.id)
                    if previewed_notes.get(note.id) != note:
                        self._publish(
                            job,
                            {
                                "type": "note",
                                **note.model_dump(by_alias=True, mode="json"),
                            },
                        )
                preview_cleanup_ids = sorted(
                    str(note_id)
                    for note_id in previewed_notes.keys()
                    - final_published_note_ids
                )
                if preview_cleanup_ids:
                    self._publish(
                        job,
                        {
                            "type": "note_cleanup",
                            "removedNoteIds": preview_cleanup_ids,
                        },
                    )
                log_backend_event(
                    "job",
                    (
                        f"id={job.id} transcription_result={input_name} "
                        f"assembled={assembler.published_count} "
                        f"published={len(published_notes)} "
                        f"corrected={assembler.corrected_count} "
                        f"discarded={assembler.discarded_count} "
                        f"invalid_chunks={len(invalid_chunks)} "
                        "invalid_chunk_discarded="
                        f"{postprocessing.invalid_chunk_discarded_count} "
                        f"audio_tail_discarded="
                        f"{postprocessing.audio_tail_discarded_count} "
                        f"audio_tail_truncated="
                        f"{postprocessing.audio_tail_truncated_count} "
                        "chunk_boundary_extended="
                        f"{postprocessing.chunk_boundary_extended_count} "
                        f"pitch_inactive_truncated="
                        f"{postprocessing.pitch_inactive_truncated_count} "
                        "chain_discarded="
                        f"{postprocessing.pathological_chain_discarded_count} "
                        "pathological_chains="
                        f"{postprocessing.pathological_chain_count} "
                        f"mapped_duplicate_discarded="
                        f"{mapped_duplicate_discarded} "
                        "candidate_rejected="
                        f"{assembler.rejected_instrument_count} "
                        f"pending_discarded={pending_discarded}"
                    ),
                )
                self._publish(
                    job,
                    {
                        "type": "partial_result",
                        "inputName": input_name,
                        "completedInputs": index + 1,
                        "totalInputs": len(transcription_inputs),
                        "completedPasses": (
                            index + 1 + additional_passes_completed
                        ),
                        "totalPasses": progress_input_count,
                        "noteCount": len(published_notes),
                        "assembledNoteCount": assembler.published_count,
                        "invalidChunkCount": len(invalid_chunks),
                        "invalidChunkDiscardedNoteCount": (
                            postprocessing.invalid_chunk_discarded_count
                        ),
                        "audioTailDiscardedNoteCount": (
                            postprocessing.audio_tail_discarded_count
                        ),
                        "audioTailTruncatedNoteCount": (
                            postprocessing.audio_tail_truncated_count
                        ),
                        "pathologicalChainCount": (
                            postprocessing.pathological_chain_count
                        ),
                        "pathologicalChainDiscardedNoteCount": (
                            postprocessing.pathological_chain_discarded_count
                        ),
                        "mappedDuplicateDiscardedNoteCount": (
                            mapped_duplicate_discarded
                        ),
                        "timingGuideUnmodifiedNoteCount": (
                            timing_guide_unmodified_note_count
                        ),
                        "timingGuideNoteDiscardedCount": (
                            timing_guide_note_discarded_count
                        ),
                        "timingGuideNoteMergedCount": (
                            timing_guide_note_merged_count
                        ),
                        "timingGuideFilterCacheHit": (
                            timing_guide_filter_cache_hit
                        ),
                        "cacheHit": cache_hit,
                    },
                )
            if job.cancel_requested.is_set():
                raise _Cancelled
            self._set_status(job, "building_project")
            if job.cancel_requested.is_set():
                raise _Cancelled
            self._set_status(job, "completed", backend=resolved_backend)
        except _Cancelled:
            self._set_status(job, "cancelled")
        except Exception as exc:
            log_backend_event(
                "job",
                (
                    f"id={job.id} exception={type(exc).__name__} "
                    f"message={exc} traceback={traceback.format_exc()}"
                ),
            )
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
            if backend is not None and locals().get("backend_loaded", False):
                backend.unload()

    def _prune_terminal_jobs(self, job_id: UUID) -> None:
        with self._lock:
            self._terminal_job_ids.append(job_id)
            while len(self._terminal_job_ids) > MAX_RETAINED_TERMINAL_JOBS:
                expired_job_id = self._terminal_job_ids.popleft()
                self._jobs.pop(expired_job_id, None)
