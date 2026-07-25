import hashlib
from pathlib import Path

from fastapi.testclient import TestClient

from earcopy_service.api import create_app
from earcopy_service.backends import (
    BackendCapabilities,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
)
from earcopy_service.jobs import TranscriptionJobManager
from earcopy_service.model_profiles import ModelProfileStore
from earcopy_service.models import SourceAudio, Stem
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.project_io import save_project
from tests.test_model_profiles import _write_model
from earcopy_service.user_presets import UserPresetStore


class ApiFakeBackend:
    def capabilities(self):
        raise NotImplementedError

    def load(self, model_path, dtype):
        pass

    def transcribe(self, audio_path, instruments, on_event):
        on_event(BackendProgress(completed=0, total=1))
        on_event(
            BackendNoteStart(
                event_index=1,
                instrument_id=instruments[0],
                pitch=60,
                start_sec=0.0,
            )
        )
        on_event(BackendNoteEnd(event_index=1, end_sec=0.5))
        on_event(BackendProgress(completed=1, total=1))

    def unload(self):
        pass


def test_health_does_not_require_token() -> None:
    client = TestClient(create_app(session_token="secret"))
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_local_renderer_origin_is_allowed_by_cors() -> None:
    client = TestClient(create_app(session_token="secret"))

    response = client.options(
        "/api/v1/models",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "null"


def test_instruments_require_configured_token() -> None:
    client = TestClient(create_app(session_token="secret"))
    unauthorized = client.get("/api/v1/instruments")
    authorized = client.get(
        "/api/v1/instruments", headers={"Authorization": "Bearer secret"}
    )
    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert any(item["id"] == "drums" for item in authorized.json())


def test_presets_include_track_definitions() -> None:
    client = TestClient(create_app())

    response = client.get("/api/v1/presets")

    assert response.status_code == 200
    orchestra = next(item for item in response.json() if item["key"] == "orchestra")
    assert orchestra["trackCount"] == 16
    assert orchestra["tracks"][-1]["kind"] == "drums"


def test_user_preset_can_be_saved_as_and_listed(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "presets.json")
    client = TestClient(create_app(preset_store=store))

    saved = client.post(
        "/api/v1/presets",
        json={
            "name": "My Band",
            "tracks": [
                {
                    "displayName": "Keys",
                    "instrumentId": "electric_piano",
                    "color": "#112233",
                    "kind": "pitched",
                    "order": 1,
                }
            ],
        },
    )
    listed = client.get("/api/v1/presets")

    assert saved.status_code == 201
    assert saved.json()["key"].startswith("user:")
    assert listed.status_code == 200
    assert listed.json()[-1] == saved.json()


def test_transcription_job_streams_sse() -> None:
    project = create_project("api job", PRESET_BY_KEY["string-quartet"])
    manager = TranscriptionJobManager(
        backend_factory=ApiFakeBackend,
        audio_preparer=lambda path: path,
    )
    client = TestClient(create_app(job_manager=manager))

    started = client.post(
        "/api/v1/jobs/transcribe",
        json={
            "audioPath": "audio.wav",
            "modelPath": "model.safetensors",
            "tracks": [
                track.model_dump(by_alias=True, mode="json")
                for track in project.tracks
            ],
        },
    )
    assert started.status_code == 202
    job_id = started.json()["jobId"]

    events = client.get(f"/api/v1/jobs/{job_id}/events")

    assert events.status_code == 200
    assert '"type": "note"' in events.text
    assert '"status": "completed"' in events.text


def test_backend_capabilities_expose_cpu_and_cuda_only() -> None:
    class UnavailableCudaBackend(ApiFakeBackend):
        def capabilities(self):
            return BackendCapabilities(
                name="CUDA",
                device="cuda",
                dtypes=("float32", "float16"),
                available=False,
                unavailable_reason="GPUなし",
            )

    manager = TranscriptionJobManager(
        backend_factories={
            "CPU": ApiFakeBackend,
            "CUDA": UnavailableCudaBackend,
        }
    )
    client = TestClient(create_app(job_manager=manager))

    response = client.get("/api/v1/backends")

    assert response.status_code == 200
    capabilities = {item["id"]: item for item in response.json()}
    assert set(capabilities) == {"Auto", "CPU", "CUDA"}
    assert capabilities["Auto"]["available"] is True
    assert capabilities["CPU"]["available"] is True
    assert capabilities["CUDA"]["available"] is False
    assert capabilities["CUDA"]["reason"] == "GPUなし"


def test_cache_api_lists_and_deletes_selected_entry(tmp_path, monkeypatch) -> None:
    user_data = tmp_path / "UserData"
    cached = user_data / "cache" / "audio" / "analysis.wav"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"cached-audio")
    monkeypatch.setenv("EARCOPY_USER_DATA", str(user_data))
    client = TestClient(create_app())

    listed = client.get("/api/v1/cache")
    deleted = client.post(
        "/api/v1/cache/delete",
        json={"entryId": "audio/analysis.wav"},
    )

    assert listed.status_code == 200
    assert listed.json()[0]["id"] == "audio/analysis.wav"
    assert listed.json()[0]["sizeBytes"] == 12
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert not cached.exists()


def test_models_can_register_different_local_variants(tmp_path) -> None:
    small_path = _write_model(tmp_path / "small", "small")
    store = ModelProfileStore(tmp_path / "profiles.json")
    client = TestClient(create_app(model_store=store))

    validation = client.post(
        "/api/v1/models/validate",
        json={"path": str(small_path)},
    )
    registered = client.post(
        "/api/v1/models/register",
        json={
            "profileName": "軽量モデル",
            "path": str(small_path),
            "variant": "small",
            "dtype": "float32",
            "defaultBackend": "CPU",
        },
    )
    listed = client.get("/api/v1/models")

    assert validation.status_code == 200
    assert validation.json()["estimatedMemoryBytes"] > validation.json()["sizeBytes"]
    assert registered.status_code == 201
    assert registered.json()["variant"] == "small"
    assert listed.status_code == 200
    assert listed.json()[0]["modelPath"] == str(small_path.resolve())


def test_project_load_validates_and_returns_camel_case_document(tmp_path) -> None:
    project = create_project("再読込", PRESET_BY_KEY["string-quartet"])
    project.source_audio = SourceAudio(
        absolutePath=str(tmp_path / "source.wav"),
        sha256="a" * 64,
        durationSec=30,
        sampleRate=44100,
        channels=2,
    )
    path = tmp_path / "reload.ecaproj"
    save_project(project, path)
    client = TestClient(create_app())

    response = client.post("/api/v1/projects/load", json={"path": str(path)})

    assert response.status_code == 200
    assert response.json()["projectId"] == str(project.project_id)
    assert response.json()["tracks"][0]["instrumentId"] == "violin"


def test_musicxml_export_endpoint_writes_local_score(tmp_path) -> None:
    project = create_project("API MusicXML", PRESET_BY_KEY["string-quartet"])
    output = tmp_path / "api-score.musicxml"
    client = TestClient(create_app())

    response = client.post(
        "/api/v1/export/musicxml",
        json={
            "project": project.model_dump(by_alias=True, mode="json"),
            "outputPath": str(output),
        },
    )

    assert response.status_code == 200
    assert response.json()["path"] == str(output)
    assert output.read_text(encoding="utf-8").startswith("<?xml")


def test_stem_export_endpoint_copies_all_four_cached_files(tmp_path) -> None:
    project = create_project("Song", PRESET_BY_KEY["string-quartet"])
    stems = []
    for name in ("drums", "bass", "vocals", "other"):
        path = tmp_path / f"{name}.wav"
        path.write_bytes(name.encode())
        stems.append(
            Stem(
                type=name,
                cachePath=str(path),
                sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            )
        )
    project.stems = stems
    output = tmp_path / "export"
    client = TestClient(create_app())

    response = client.post(
        "/api/v1/export/stems",
        json={
            "project": project.model_dump(by_alias=True, mode="json"),
            "outputDirectory": str(output),
        },
    )

    assert response.status_code == 200
    assert {Path(path).name for path in response.json()["paths"]} == {
        "Song_drums.wav",
        "Song_bass.wav",
        "Song_vocals.wav",
        "Song_other.wav",
    }
