from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .audio import AudioInfo, inspect_audio, prepare_analysis_audio
from .cache_management import delete_cache_entry, list_cache_entries
from .instruments import INSTRUMENTS
from .jobs import TranscriptionJobManager, TranscriptionJobRequest
from .midi_export import export_midi
from .musicxml_export import export_musicxml
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
from .models import Project
from .presets import BUILTIN_PRESETS
from .project_io import load_project
from .stem_separation import export_stems
from .tempo_estimation import TempoEstimate, estimate_tempo
from .user_presets import (
    UserPresetStore,
    UserPresetTrack,
    user_preset_response,
)


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ModelValidationRequest(ApiModel):
    path: str
    variant: ModelVariant | None = None


class ModelRegistrationRequest(ApiModel):
    profile_name: str = Field(alias="profileName", min_length=1, max_length=120)
    path: str
    variant: ModelVariant | None = None
    dtype: Literal["float32", "float16"] = "float32"
    default_backend: InferenceBackend = Field(default="Auto", alias="defaultBackend")


class ScoreExportRequest(ApiModel):
    project: Project
    output_path: str = Field(alias="outputPath")


class AudioPathRequest(ApiModel):
    path: str


class ProjectPathRequest(ApiModel):
    path: str


class StemExportRequest(ApiModel):
    project: Project
    output_directory: str = Field(alias="outputDirectory")


class UserPresetSaveRequest(ApiModel):
    name: str = Field(min_length=1, max_length=120)
    tracks: list[UserPresetTrack] = Field(min_length=1, max_length=16)


class CacheDeleteRequest(ApiModel):
    entry_id: str = Field(alias="entryId")


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
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    jobs = job_manager or TranscriptionJobManager()
    user_data = Path(os.getenv("EARCOPY_USER_DATA", "UserData"))
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
        request: AudioPathRequest,
        authorization: str | None = Header(default=None),
    ) -> TempoEstimate:
        await require_token(authorization)
        try:
            analysis_audio = prepare_analysis_audio(
                Path(request.path),
                audio_cache,
            )
            return estimate_tempo(analysis_audio)
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/jobs/transcribe", status_code=202)
    async def transcribe(
        request: TranscriptionJobRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        return {"jobId": str(jobs.start(request))}

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

    @app.post("/api/v1/export/musicxml")
    async def musicxml_export(
        request: ScoreExportRequest,
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        await require_token(authorization)
        output_path = Path(request.output_path)
        try:
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
