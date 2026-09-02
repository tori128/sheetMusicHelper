import hashlib
import os
from pathlib import Path
from xml.etree import ElementTree as ET

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
from earcopy_service.models import Note, SourceAudio, Stem
from earcopy_service.musicxml_export import MUSICXML_PREVIEW_MEASURE_LIMIT
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.project_io import save_project
from earcopy_service.stem_separation import STEM_CACHE_VERSION, stem_model_status
from tests.test_model_profiles import _write_model
from earcopy_service.user_presets import UserPresetStore, UserPresetTrack


class ApiFakeBackend:
    def capabilities(self):
        raise NotImplementedError

    def load(self, model_path, dtype):
        pass

    def transcribe(
        self,
        audio_path,
        instruments,
        on_event,
        *,
        beam_size=1,
        prelude_forcing=True,
        batch_size=1,
    ):
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


def test_tempo_estimate_endpoint_passes_the_time_signature(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_path = tmp_path / "source.wav"
    calls = {}
    monkeypatch.setattr(
        "earcopy_service.api.prepare_analysis_audio",
        lambda path, _cache: path,
    )

    def estimate(path, *, numerator, denominator):
        calls["arguments"] = (path, numerator, denominator)
        return {
            "bpm": 123.4,
            "sampleRate": 22_050,
            "beatOffsetSec": 0.42,
        }

    monkeypatch.setattr("earcopy_service.api.estimate_tempo", estimate)
    client = TestClient(create_app(session_token="secret"))

    response = client.post(
        "/api/v1/tempo/estimate",
        headers={"Authorization": "Bearer secret"},
        json={
            "path": str(source_path),
            "numerator": 3,
            "denominator": 4,
        },
    )

    assert response.status_code == 200
    assert response.json()["beatOffsetSec"] == 0.42
    assert calls["arguments"] == (source_path, 3, 4)


def test_spectral_difference_endpoint_returns_beat_values(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import numpy
    import soundfile

    sample_rate = 22_050
    time = numpy.arange(sample_rate * 2) / sample_rate
    source_audio = numpy.sin(2 * numpy.pi * 440 * time).astype(numpy.float32)
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    soundfile.write(source_path, source_audio, sample_rate, subtype="FLOAT")
    soundfile.write(
        synthesized_path,
        source_audio * 0.2,
        sample_rate,
        subtype="FLOAT",
    )
    monkeypatch.setattr(
        "earcopy_service.api.prepare_analysis_audio",
        lambda path, _cache: path,
    )
    client = TestClient(create_app(session_token="secret"))

    response = client.post(
        "/api/v1/audio/spectral-difference",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourcePaths": [str(source_path)],
            "synthesizedPath": str(synthesized_path),
            "durationSec": 2,
            "timelineOffsetSec": 0,
            "bpm": 60,
            "beatOffsetSec": 0,
            "numerator": 4,
            "denominator": 4,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["intervals"]) == 2
    assert payload["maximum"] < 0.001


def test_stem_amplitude_velocity_endpoint_does_not_start_transcription(
    tmp_path: Path,
) -> None:
    import numpy
    import soundfile

    stem_path = tmp_path / "piano.wav"
    soundfile.write(
        stem_path,
        numpy.full((200, 2), 10 ** (-6 / 20), dtype=numpy.float32),
        1_000,
        subtype="FLOAT",
    )
    note = Note(
        sourceInstrumentId="acoustic_piano",
        trackId="00000000-0000-0000-0000-000000000001",
        pitch=60,
        rawStartSec=0,
        rawEndSec=0.2,
        startSec=0,
        endSec=0.2,
        velocity=37,
    )
    stem = Stem(
        type="piano",
        cachePath=str(stem_path),
        sha256=hashlib.sha256(stem_path.read_bytes()).hexdigest(),
    )

    class RejectTranscriptionManager:
        def start(self, _request):
            raise AssertionError("MuScriptor must not be started")

    client = TestClient(
        create_app(
            session_token="secret",
            job_manager=RejectTranscriptionManager(),
        )
    )
    headers = {"Authorization": "Bearer secret"}
    request = {
        "notes": [note.model_dump(by_alias=True, mode="json")],
        "stems": [stem.model_dump(by_alias=True, mode="json")],
    }

    enabled = client.post(
        "/api/v1/notes/stem-amplitude-velocity",
        headers=headers,
        json={**request, "enabled": True},
    )
    disabled = client.post(
        "/api/v1/notes/stem-amplitude-velocity",
        headers=headers,
        json={**request, "enabled": False},
    )

    assert enabled.status_code == 200
    assert enabled.json()["notes"][0]["velocity"] == 127
    assert disabled.status_code == 200
    assert disabled.json()["notes"][0]["velocity"] == 100


def test_saved_transcription_options_endpoint_does_not_start_transcription() -> None:
    project = create_project("saved results", PRESET_BY_KEY["general-band"])
    piano_track = next(
        track
        for track in project.tracks
        if track.instrument_id == "acoustic_piano"
    )
    note = Note(
        sourceInstrumentId="acoustic_piano",
        trackId=piano_track.id,
        pitch=60,
        rawStartSec=1,
        rawEndSec=1.5,
        startSec=1,
        endSec=1.5,
    )

    class RejectTranscriptionManager:
        def start(self, _request):
            raise AssertionError("MuScriptor must not be started")

    client = TestClient(
        create_app(
            session_token="secret",
            job_manager=RejectTranscriptionManager(),
        )
    )
    response = client.post(
        "/api/v1/notes/saved-transcription-options",
        headers={"Authorization": "Bearer secret"},
        json={
            "inputResults": [
                {
                    "inputName": "piano",
                    "role": "primary",
                    "transcriptionPass": "drums_added_audio",
                    "notes": [note.model_dump(by_alias=True, mode="json")],
                }
            ],
            "tracks": [
                piano_track.model_dump(by_alias=True, mode="json")
            ],
            "instrumentSelectionMode": "fixed",
            "timingGuideNoteFilter": False,
        },
    )

    assert response.status_code == 200
    assert response.json()["notes"] == [
        note.model_dump(by_alias=True, mode="json")
    ]


def test_playback_audio_endpoints_prepare_and_return_pcm_frames(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import numpy
    import soundfile

    source_path = tmp_path / "source.wav"
    samples = numpy.array(
        [[0.0, 0.25], [0.5, 0.75], [1.0, -1.0]],
        dtype=numpy.float32,
    )
    soundfile.write(source_path, samples, 44_100, subtype="FLOAT")
    monkeypatch.setattr(
        "earcopy_service.api.prepare_analysis_audio",
        lambda path, _cache: path,
    )
    client = TestClient(create_app(session_token="secret"))
    headers = {"Authorization": "Bearer secret"}

    prepared = client.post(
        "/api/v1/audio/playback/prepare",
        headers=headers,
        json={"path": str(source_path)},
    )
    frames = client.post(
        "/api/v1/audio/playback/frames",
        headers=headers,
        json={
            "sourcePaths": [str(source_path)],
            "startFrame": 1,
            "frameCount": 3,
        },
    )

    assert prepared.status_code == 200
    assert prepared.json() == {
        "path": str(source_path.resolve()),
        "sampleRate": 44_100,
        "channels": 2,
        "frameCount": 3,
    }
    assert frames.status_code == 200
    decoded = numpy.frombuffer(frames.content, dtype="<f4").reshape(1, 3, 2)
    numpy.testing.assert_allclose(decoded[0, :2], samples[1:])
    numpy.testing.assert_array_equal(decoded[0, 2], 0)


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
    piano = next(
        item for item in authorized.json() if item["id"] == "acoustic_piano"
    )
    assert piano["gmPrograms"][1] == {
        "program": 1,
        "displayNameJa": "ブライトアコースティックピアノ",
    }
    voice = next(item for item in authorized.json() if item["id"] == "voice")
    assert voice["gmPrograms"] == [
        {"program": 52, "displayNameJa": "クワイア"},
        {"program": 53, "displayNameJa": "ボイス"},
        {"program": 54, "displayNameJa": "シンセボイス"},
        {"program": 71, "displayNameJa": "クラリネット（聞き取り用）"}
    ]


def test_presets_include_track_definitions() -> None:
    client = TestClient(create_app())

    response = client.get("/api/v1/presets")

    assert response.status_code == 200
    orchestra = next(item for item in response.json() if item["key"] == "orchestra")
    assert orchestra["trackCount"] == 16
    assert orchestra["tracks"][-1]["kind"] == "drums"
    assert orchestra["tracks"][0]["gmProgram"] == 73
    assert len({track["color"] for track in orchestra["tracks"]}) == 16


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
                    "gmProgram": 5,
                }
            ],
        },
    )
    listed = client.get("/api/v1/presets")

    assert saved.status_code == 201
    assert saved.json()["key"].startswith("user:")
    assert saved.json()["tracks"][0]["gmProgram"] == 5
    assert listed.status_code == 200
    assert listed.json()[-1] == saved.json()


def test_user_preset_can_be_overwritten_without_changing_its_id(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "presets.json")
    client = TestClient(create_app(preset_store=store))
    preset = store.save_as(
        "Before",
        [
            UserPresetTrack(
                displayName="Piano",
                instrumentId="acoustic_piano",
                color="#112233",
                kind="pitched",
                order=1,
            )
        ],
    )

    overwritten = client.put(
        f"/api/v1/presets/{preset.id}",
        json={
            "name": "After",
            "tracks": [
                {
                    "displayName": "Bass",
                    "instrumentId": "electric_bass",
                    "color": "#445566",
                    "kind": "pitched",
                    "order": 1,
                    "gmProgram": 33,
                }
            ],
        },
    )

    assert overwritten.status_code == 200
    assert overwritten.json()["id"] == str(preset.id)
    assert overwritten.json()["name"] == "After"
    assert overwritten.json()["tracks"][0]["instrumentId"] == "electric_bass"
    assert len(store.list()) == 1
    assert store.list()[0].id == preset.id


def test_overwriting_an_unknown_user_preset_returns_not_found(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "presets.json")
    client = TestClient(create_app(preset_store=store))

    response = client.put(
        "/api/v1/presets/00000000-0000-0000-0000-000000000001",
        json={
            "name": "Unknown",
            "tracks": [
                {
                    "displayName": "Piano",
                    "instrumentId": "acoustic_piano",
                    "color": "#112233",
                    "kind": "pitched",
                    "order": 1,
                }
            ],
        },
    )

    assert response.status_code == 404


def test_user_preset_can_be_deleted(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "presets.json")
    client = TestClient(create_app(preset_store=store))
    preset = store.save_as(
        "Temporary",
        [
            UserPresetTrack(
                displayName="Piano",
                instrumentId="acoustic_piano",
                color="#112233",
                kind="pitched",
                order=1,
            )
        ],
    )

    deleted = client.delete(f"/api/v1/presets/{preset.id}")

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert store.list() == []
    assert client.delete(f"/api/v1/presets/{preset.id}").status_code == 404


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
                {
                    **track.model_dump(by_alias=True, mode="json"),
                    "playbackVolume": 42,
                }
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


def test_stem_separation_status_reports_external_model(
    tmp_path, monkeypatch
) -> None:
    model_directory = (
        tmp_path / "models" / "bs-roformer" / "sw-fixed"
    )
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_directory))
    client = TestClient(create_app(session_token="secret"))

    missing = client.get(
        "/api/v1/stem-separation",
        headers={"Authorization": "Bearer secret"},
    )
    model_directory.mkdir(parents=True)
    (model_directory / "BS-Rofo-SW-Fixed.ckpt").touch()
    available = client.get(
        "/api/v1/stem-separation",
        headers={"Authorization": "Bearer secret"},
    )

    assert missing.status_code == 200
    assert missing.json()["available"] is False
    assert missing.json()["modelDirectory"] == str(model_directory.resolve())
    assert missing.json()["licenseStatus"] == "Unknown"
    assert missing.json()["modelSizeBytes"] == 699_412_152
    assert missing.json()["modelSha256"] == (
        "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
    )
    payload = available.json()
    assert payload["available"] is True
    assert payload["modelDirectory"] == str(model_directory.resolve())
    assert payload["modelName"] == "BS-RoFormer SW Fixed"
    assert payload["reason"] == ""


def test_stem_model_download_requires_acknowledgement(
    tmp_path,
    monkeypatch,
) -> None:
    model_directory = tmp_path / "models" / "bs-roformer" / "sw-fixed"
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_directory))
    downloaded = False

    def download() -> dict[str, bool | str | int]:
        nonlocal downloaded
        downloaded = True
        return {
            **stem_model_status(),
            "available": True,
            "reason": "",
        }

    monkeypatch.setattr("earcopy_service.api.download_stem_model", download)
    client = TestClient(create_app(session_token="secret"))

    rejected = client.post(
        "/api/v1/stem-separation/model/download",
        json={"licenseStatusAcknowledged": False},
        headers={"Authorization": "Bearer secret"},
    )
    assert rejected.status_code == 422
    assert downloaded is False

    accepted = client.post(
        "/api/v1/stem-separation/model/download",
        json={"licenseStatusAcknowledged": True},
        headers={"Authorization": "Bearer secret"},
    )

    assert accepted.status_code == 200
    assert accepted.json()["available"] is True
    assert downloaded is True


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


def test_app_startup_keeps_latest_ten_cache_entries_per_kind(
    tmp_path, monkeypatch
) -> None:
    user_data = tmp_path / "UserData"
    audio_root = user_data / "cache" / "audio"
    for index in range(12):
        entry = audio_root / f"audio-{index:02d}"
        entry.mkdir(parents=True)
        analysis = entry / "analysis.wav"
        analysis.write_bytes(bytes([index]))
        os.utime(analysis, (1_000_000 + index, 1_000_000 + index))
    obsolete = user_data / "cache" / "stems" / "components-v1" / "source"
    obsolete.mkdir(parents=True)
    (obsolete / "drums.wav").write_bytes(b"obsolete")
    current = user_data / "cache" / "stems" / STEM_CACHE_VERSION / "source"
    current.mkdir(parents=True)
    (current / "drums.wav").write_bytes(b"current")
    monkeypatch.setenv("EARCOPY_USER_DATA", str(user_data))

    client = TestClient(create_app())
    listed = client.get("/api/v1/cache")

    assert listed.status_code == 200
    audio_entries = [
        entry for entry in listed.json() if entry["kind"] == "audio"
    ]
    assert len(audio_entries) == 10
    assert not obsolete.parent.exists()
    assert current.exists()


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
        timelineOffsetSec=-0.5,
    )
    path = tmp_path / "reload.ecaproj"
    save_project(project, path)
    client = TestClient(create_app())

    response = client.post("/api/v1/projects/load", json={"path": str(path)})

    assert response.status_code == 200
    assert response.json()["projectId"] == str(project.project_id)
    assert response.json()["tracks"][0]["instrumentId"] == "violin"
    assert response.json()["sourceAudio"]["timelineOffsetSec"] == -0.5


def test_musicxml_export_endpoint_writes_local_score(tmp_path) -> None:
    project = create_project("API MusicXML", PRESET_BY_KEY["string-quartet"])
    violin = project.tracks[0]
    project.notes = [
        Note(
            sourceInstrumentId=violin.instrument_id,
            trackId=violin.id,
            pitch=60,
            rawStartSec=0,
            rawEndSec=0.5,
            startSec=0,
            endSec=0.5,
        )
    ]
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


def test_midi_export_endpoint_writes_current_project_without_score_validation(
    tmp_path,
) -> None:
    project = create_project("Current MIDI", PRESET_BY_KEY["string-quartet"])
    output = tmp_path / "current.mid"
    client = TestClient(create_app())

    response = client.post(
        "/api/v1/export/midi",
        json={
            "project": project.model_dump(by_alias=True, mode="json"),
            "outputPath": str(output),
        },
    )

    assert response.status_code == 200
    assert response.json()["path"] == str(output)
    assert output.exists()


def test_score_validation_and_musicxml_preview_endpoints() -> None:
    project = create_project("API preview", PRESET_BY_KEY["string-quartet"])
    client = TestClient(create_app())
    payload = {"project": project.model_dump(by_alias=True, mode="json")}

    validation = client.post("/api/v1/export/validate", json=payload)
    preview = client.post("/api/v1/export/musicxml/preview", json=payload)

    assert validation.status_code == 200
    assert validation.json()["errorCount"] == 1
    assert validation.json()["issues"][0]["code"] == "empty_score"
    assert preview.status_code == 200
    assert "<score-partwise" in preview.json()["xml"]


def test_score_validation_quantizes_to_selected_resolution() -> None:
    project = create_project("API quantize", PRESET_BY_KEY["string-quartet"])
    violin = project.tracks[0]
    project.tempo.beat_offset_sec = 0.1
    project.tempo.quantize_grid = "1/4"
    project.notes = [
        Note(
            sourceInstrumentId=violin.instrument_id,
            trackId=violin.id,
            pitch=60,
            rawStartSec=0.36,
            rawEndSec=0.86,
            startSec=0.36,
            endSec=0.86,
        )
    ]
    client = TestClient(create_app())

    response = client.post(
        "/api/v1/export/validate",
        json={"project": project.model_dump(by_alias=True, mode="json")},
    )

    assert response.status_code == 200
    assert all(
        issue["code"] != "off_grid" for issue in response.json()["issues"]
    )


def test_musicxml_preview_limits_measures_without_truncating_export(tmp_path) -> None:
    project = create_project("Long API preview", PRESET_BY_KEY["string-quartet"])
    violin = project.tracks[0]
    project.notes = [
        Note(
            sourceInstrumentId=violin.instrument_id,
            trackId=violin.id,
            pitch=60,
            rawStartSec=0,
            rawEndSec=45,
            startSec=0,
            endSec=45,
        )
    ]
    client = TestClient(create_app())
    payload = {"project": project.model_dump(by_alias=True, mode="json")}

    preview = client.post("/api/v1/export/musicxml/preview", json=payload)
    output = tmp_path / "full-score.musicxml"
    exported = client.post(
        "/api/v1/export/musicxml",
        json={**payload, "outputPath": str(output)},
    )

    assert preview.status_code == 200
    preview_root = ET.fromstring(preview.json()["xml"])
    assert {len(part.findall("measure")) for part in preview_root.findall("part")} == {
        MUSICXML_PREVIEW_MEASURE_LIMIT
    }
    assert exported.status_code == 200
    export_root = ET.parse(output).getroot()
    assert (
        min(len(part.findall("measure")) for part in export_root.findall("part"))
        > MUSICXML_PREVIEW_MEASURE_LIMIT
    )


def test_stem_export_endpoint_copies_all_six_cached_files(tmp_path) -> None:
    project = create_project("Song", PRESET_BY_KEY["string-quartet"])
    stems = []
    for name in ("drums", "bass", "vocals", "other", "piano", "guitar"):
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
        "Song_piano.wav",
        "Song_guitar.wav",
    }
