from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Literal
from uuid import UUID
from xml.etree import ElementTree as ET

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from . import __version__
from .audio import (
    AudioInfo,
    PlaybackAudioInfo,
    inspect_audio,
    playback_audio_info,
    prepare_analysis_audio,
    read_playback_audio_frames,
)
from .cache_management import (
    delete_cache_entry,
    list_cache_entries,
    prune_cache_entries,
)
from .instruments import INSTRUMENTS, get_instrument
from .jobs import TranscriptionJobManager, TranscriptionJobRequest
from .midi_export import export_midi
from .musicxml_export import (
    MUSICXML_PREVIEW_MEASURE_LIMIT,
    build_musicxml,
    export_musicxml,
)
from .model_profiles import (
    InferenceBackend,
    ModelProfile,
    ModelProfileStore,
    configured_model_directories,
)
from .model_validation import (
    ModelValidationResult,
    ModelVariant,
    validate_model_file,
)
from .models import Note, Project, Stem, Track, TranscriptionInputResult
from .presets import BUILTIN_PRESETS
from .project_io import load_project
from .score_validation import ScoreValidationResult, validate_score
from .stem_separation import (
    configured_stem_cache_version,
    download_stem_model,
    export_stems,
    stem_model_status,
)
from .spectral_difference import calculate_spectral_difference
from .tempo_estimation import TempoEstimate, estimate_tempo
from .timebase import quantize_project
from .transcription_option_processing import apply_saved_transcription_options
from .user_presets import (
    UserPresetStore,
    UserPresetTrack,
    user_preset_response,
)
from .velocity_estimation import apply_stem_amplitude_velocity_setting


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ModelValidationRequest(ApiModel):
    path: str
    variant: ModelVariant | None = None


class ModelRegistrationRequest(ApiModel):
    profile_name: str = Field(alias="profileName", min_length=1, max_length=120)
    path: str
    variant: ModelVariant | None = None
    dtype: Literal["float32", "float16"] = "float16"
    default_backend: InferenceBackend = Field(default="Auto", alias="defaultBackend")


class ScoreExportRequest(ApiModel):
    project: Project
    output_path: str = Field(alias="outputPath")


class ScoreProjectRequest(ApiModel):
    project: Project


class AudioPathRequest(ApiModel):
    path: str


class TempoEstimateRequest(ApiModel):
    path: str
    numerator: int = Field(ge=1, le=12)
    denominator: Literal[2, 4, 8, 16]


class PlaybackAudioFramesRequest(ApiModel):
    source_paths: list[str] = Field(alias="sourcePaths", min_length=1, max_length=9)
    start_frame: int = Field(alias="startFrame", ge=0)
    frame_count: int = Field(alias="frameCount", ge=1, le=176_400)


class ProjectPathRequest(ApiModel):
    path: str


class StemExportRequest(ApiModel):
    project: Project
    output_directory: str = Field(alias="outputDirectory")


class StemModelDownloadRequest(ApiModel):
    license_status_acknowledged: Literal[True] = Field(
        alias="licenseStatusAcknowledged"
    )


class UserPresetSaveRequest(ApiModel):
    name: str = Field(min_length=1, max_length=120)
    tracks: list[UserPresetTrack] = Field(min_length=1, max_length=16)


def _require_exportable_musicxml(project: Project) -> None:
    quantized_project = quantize_project(
        project,
        project.tempo.quantize_grid,
    )
    validation = validate_score(quantized_project)
    errors = [
        issue.message
        for issue in validation.issues
        if issue.severity == "error"
    ]
    if not errors:
        return
    summary = " / ".join(errors[:3])
    remaining = len(errors) - 3
    suffix = f" / ほか{remaining}件" if remaining > 0 else ""
    raise ValueError(
        f"書き出し前検査で{len(errors)}件のエラーを検出しました: "
        f"{summary}{suffix}"
    )


class CacheDeleteRequest(ApiModel):
    entry_id: str = Field(alias="entryId")


class SpectralDifferenceRequest(ApiModel):
    source_paths: list[str] = Field(alias="sourcePaths", min_length=1, max_length=6)
    synthesized_path: str = Field(alias="synthesizedPath")
    duration_sec: float = Field(alias="durationSec", gt=0, le=900)
    timeline_offset_sec: float = Field(alias="timelineOffsetSec")
    bpm: float = Field(gt=0, le=300)
    beat_offset_sec: float = Field(alias="beatOffsetSec")
    numerator: int = Field(ge=1, le=12)
    denominator: Literal[2, 4, 8, 16]


class StemAmplitudeVelocityRequest(ApiModel):
    notes: list[Note]
    stems: list[Stem]
    enabled: bool


class SavedTranscriptionOptionsRequest(ApiModel):
    input_results: list[TranscriptionInputResult] = Field(alias="inputResults")
    tracks: list[Track]
    instrument_selection_mode: Literal["fixed", "automatic"] = Field(
        alias="instrumentSelectionMode"
    )
    timing_guide_note_filter: bool = Field(alias="timingGuideNoteFilter")


def create_app(
    session_token: str | None = None,
    job_manager: TranscriptionJobManager | None = None,
    model_store: ModelProfileStore | None = None,
    preset_store: UserPresetStore | None = None,
) -> FastAPI:
    token = session_token if session_token is not None else os.getenv(
        "EARCOPY_SESSION_TOKEN"
    )
    app = FastAPI(title="EarCopy Assist Local API", version=__version__)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(null|http://(127\.0\.0\.1|localhost)(:\d+)?)$",
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    configured_user_data = os.getenv("EARCOPY_USER_DATA")
    user_data = Path(configured_user_data or "UserData")
    if configured_user_data is not None:
        prune_cache_entries(
            user_data / "cache",
            active_stem_version=configured_stem_cache_version(),
        )
    jobs = job_manager or TranscriptionJobManager()
    audio_cache = user_data / "cache" / "audio"
    profiles = model_store or ModelProfileStore(
        user_data / "model-profiles.json"
    )
    user_presets = preset_store or UserPresetStore(user_data / "presets.json")

    async def require_token(authorization: str | None = Header(default=None)) -> None:
        if not token:
            return
        expected = f"Bearer {token}"
        if authorization is None or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="セッショントークンが不正です")

    @app.get("/api/v1/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @app.get("/api/v1/instruments", dependencies=[])
    async def instruments(authorization: str | None = Header(default=None)) -> list[dict]:
        await require_token(authorization)
        return [
            {
                "id": instrument.id,
                "displayNameJa": instrument.display_name_ja,
                "kind": instrument.kind,
                "gmProgram": instrument.gm_program,
                "gmPrograms": [
                    {
                        "program": option.program,
                        "displayNameJa": option.display_name_ja,
                    }
                    for option in instrument.gm_programs
                ],
            }
            for instrument in INSTRUMENTS
        ]

    @app.get("/api/v1/presets")
    async def presets(authorization: str | None = Header(default=None)) -> list[dict]:
        await require_token(authorization)
        builtins = [
            {
                "id": str(preset.id),
                "key": preset.key,
                "name": preset.name,
                "trackCount": len(preset.tracks),
                "tracks": [
                    {
                        "displayName": track.display_name,
                        "instrumentId": track.instrument_id,
                        "color": track.color,
                        "kind": (
                            "drums"
                            if track.instrument_id == "drums"
                            else "pitched"
                        ),
                        "order": order,
                        "gmProgram": get_instrument(
                            track.instrument_id
                        ).gm_program,
                    }
                    for order, track in enumerate(preset.tracks, start=1)
                ],
            }
            for preset in BUILTIN_PRESETS
        ]
        try:
            users = [
                user_preset_response(preset)
                for preset in user_presets.list()
            ]
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return [*builtins, *users]

    @app.post("/api/v1/presets", status_code=201)
    async def save_user_preset(
        request: UserPresetSaveRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        await require_token(authorization)
        try:
            preset = user_presets.save_as(request.name, request.tracks)
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return user_preset_response(preset)

    @app.put("/api/v1/presets/{preset_id}")
    async def overwrite_user_preset(
        preset_id: UUID,
        request: UserPresetSaveRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        await require_token(authorization)
        try:
            preset = user_presets.overwrite(
                preset_id,
                request.name,
                request.tracks,
            )
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if preset is None:
            raise HTTPException(status_code=404, detail="プリセットが見つかりません")
        return user_preset_response(preset)

    @app.delete("/api/v1/presets/{preset_id}")
    async def delete_user_preset(
        preset_id: UUID,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        await require_token(authorization)
        try:
            deleted = user_presets.delete(preset_id)
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not deleted:
            raise HTTPException(status_code=404, detail="プリセットが見つかりません")
        return {"deleted": True}

    @app.post("/api/v1/models/validate")
    async def validate_model(
        request: ModelValidationRequest,
        authorization: str | None = Header(default=None),
    ) -> ModelValidationResult:
        await require_token(authorization)
        try:
            return validate_model_file(Path(request.path), request.variant)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/models")
    async def list_models(
        authorization: str | None = Header(default=None),
    ) -> list[ModelProfile]:
        await require_token(authorization)
        try:
            return profiles.discover_local_models(configured_model_directories())
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/api/v1/backends")
    async def list_backends(
        authorization: str | None = Header(default=None),
    ) -> list[dict[str, str | bool]]:
        await require_token(authorization)
        return jobs.backend_capabilities()

    @app.get("/api/v1/stem-separation")
    async def stem_separation_status(
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool | str | int]:
        await require_token(authorization)
        return stem_model_status()

    @app.post("/api/v1/stem-separation/model/download")
    async def stem_separation_model_download(
        request: StemModelDownloadRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool | str | int]:
        await require_token(authorization)
        try:
            return await run_in_threadpool(download_stem_model)
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/cache")
    async def cache_entries(
        authorization: str | None = Header(default=None),
    ) -> list[dict]:
        await require_token(authorization)
        try:
            return [
                entry.model_dump(by_alias=True, mode="json")
                for entry in list_cache_entries(user_data / "cache")
            ]
        except OSError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/api/v1/cache/delete")
    async def cache_delete(
        request: CacheDeleteRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, bool]:
        await require_token(authorization)
        try:
            delete_cache_entry(user_data / "cache", request.entry_id)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"deleted": True}

    @app.post("/api/v1/models/register", status_code=201)
    async def register_model(
        request: ModelRegistrationRequest,
        authorization: str | None = Header(default=None),
    ) -> ModelProfile:
        await require_token(authorization)
        try:
            return profiles.register(
                profile_name=request.profile_name,
                model_path=Path(request.path),
                expected_variant=request.variant,
                dtype=request.dtype,
                default_backend=request.default_backend,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/audio/inspect")
    async def audio_inspect(
        request: AudioPathRequest,
        authorization: str | None = Header(default=None),
    ) -> AudioInfo:
        await require_token(authorization)
        try:
            return inspect_audio(Path(request.path))
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/audio/playback/prepare")
    async def playback_audio_prepare(
        request: AudioPathRequest,
        authorization: str | None = Header(default=None),
    ) -> PlaybackAudioInfo:
        await require_token(authorization)
        try:
            path = await run_in_threadpool(
                prepare_analysis_audio,
                Path(request.path),
                audio_cache,
            )
            return playback_audio_info(path)
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/audio/playback/frames")
    async def playback_audio_frames(
        request: PlaybackAudioFramesRequest,
        authorization: str | None = Header(default=None),
    ) -> Response:
        await require_token(authorization)
        try:
            content = await run_in_threadpool(
                read_playback_audio_frames,
                [Path(path) for path in request.source_paths],
                request.start_frame,
                request.frame_count,
            )
            return Response(
                content=content,
                media_type="application/octet-stream",
                headers={
                    "X-Audio-Source-Count": str(len(request.source_paths)),
                    "X-Audio-Frame-Count": str(request.frame_count),
                },
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/projects/load")
    async def project_load(
        request: ProjectPathRequest,
        authorization: str | None = Header(default=None),
    ) -> Project:
        await require_token(authorization)
        try:
            project = load_project(Path(request.path))
            if project.source_audio is None:
                raise ValueError("音源情報のないプロジェクトは編集画面で開けません")
            return project
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/tempo/estimate")
    async def tempo_estimate(
        request: TempoEstimateRequest,
        authorization: str | None = Header(default=None),
    ) -> TempoEstimate:
        await require_token(authorization)
        try:
            analysis_audio = prepare_analysis_audio(
                Path(request.path),
                audio_cache,
            )
            return estimate_tempo(
                analysis_audio,
                numerator=request.numerator,
                denominator=request.denominator,
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/audio/spectral-difference")
    async def spectral_difference(
        request: SpectralDifferenceRequest,
        authorization: str | None = Header(default=None),
    ) -> dict:
        await require_token(authorization)

        def calculate():
            source_paths = [
                prepare_analysis_audio(Path(path), audio_cache)
                for path in request.source_paths
            ]
            return calculate_spectral_difference(
                source_paths,
                Path(request.synthesized_path),
                duration_sec=request.duration_sec,
                timeline_offset_sec=request.timeline_offset_sec,
                bpm=request.bpm,
                beat_offset_sec=request.beat_offset_sec,
                numerator=request.numerator,
                denominator=request.denominator,
            )

        try:
            result = await run_in_threadpool(calculate)
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "intervals": [
                {
                    "startSec": interval.start_sec,
                    "endSec": interval.end_sec,
                    "measureNumber": interval.measure_number,
                    "beatInMeasure": interval.beat_in_measure,
                    "value": interval.value,
                }
                for interval in result.intervals
            ],
            "minimum": result.minimum,
            "maximum": result.maximum,
        }

    @app.post("/api/v1/jobs/transcribe", status_code=202)
    async def transcribe(
        request: TranscriptionJobRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        return {"jobId": str(jobs.start(request))}

    @app.post("/api/v1/notes/stem-amplitude-velocity")
    async def stem_amplitude_velocity(
        request: StemAmplitudeVelocityRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, list[Note]]:
        await require_token(authorization)
        try:
            result = await run_in_threadpool(
                apply_stem_amplitude_velocity_setting,
                request.notes,
                request.stems,
                request.enabled,
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if result.unavailable_paths:
            unavailable = ", ".join(map(str, result.unavailable_paths))
            raise HTTPException(
                status_code=400,
                detail=f"分離後音源を読み込めません: {unavailable}",
            )
        return {"notes": result.notes}

    @app.post("/api/v1/notes/saved-transcription-options")
    async def saved_transcription_options(
        request: SavedTranscriptionOptionsRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, list[Note]]:
        await require_token(authorization)
        try:
            notes = await run_in_threadpool(
                apply_saved_transcription_options,
                request.input_results,
                request.tracks,
                request.instrument_selection_mode,
                request.timing_guide_note_filter,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"notes": notes}

    @app.get("/api/v1/jobs/{job_id}/events")
    async def job_events(
        job_id: UUID,
        after: int = 0,
        authorization: str | None = Header(default=None),
    ) -> StreamingResponse:
        await require_token(authorization)
        try:
            jobs.status(job_id)
            stream = jobs.iter_sse(job_id, after_sequence=after)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return StreamingResponse(stream, media_type="text/event-stream")

    @app.post("/api/v1/jobs/{job_id}/cancel")
    async def cancel_job(
        job_id: UUID,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        try:
            status = jobs.cancel(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"jobId": str(job_id), "status": status}

    @app.post("/api/v1/export/midi")
    async def midi_export(
        request: ScoreExportRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        output_path = Path(request.output_path)
        try:
            export_midi(request.project, output_path)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"path": str(output_path)}

    @app.post("/api/v1/export/validate")
    async def score_export_validation(
        request: ScoreProjectRequest,
        authorization: str | None = Header(default=None),
    ) -> ScoreValidationResult:
        await require_token(authorization)
        return validate_score(
            quantize_project(
                request.project,
                request.project.tempo.quantize_grid,
            )
        )

    @app.post("/api/v1/export/musicxml/preview")
    async def musicxml_preview(
        request: ScoreProjectRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        quantized_project = quantize_project(
            request.project,
            request.project.tempo.quantize_grid,
        )
        root = build_musicxml(
            quantized_project,
            measure_limit=MUSICXML_PREVIEW_MEASURE_LIMIT,
        ).getroot()
        return {"xml": ET.tostring(root, encoding="unicode")}

    @app.post("/api/v1/export/musicxml")
    async def musicxml_export(
        request: ScoreExportRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        output_path = Path(request.output_path)
        try:
            _require_exportable_musicxml(request.project)
            export_musicxml(request.project, output_path)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"path": str(output_path)}

    @app.post("/api/v1/export/stems")
    async def stems_export(
        request: StemExportRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, list[str]]:
        await require_token(authorization)
        try:
            paths = export_stems(
                request.project.stems,
                Path(request.output_directory),
                request.project.name,
            )
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"paths": [str(path) for path in paths]}

    return app


app = create_app()
