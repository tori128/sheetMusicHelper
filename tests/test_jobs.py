from earcopy_service.backends import (
    BackendCapabilities,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
)
from earcopy_service.jobs import TranscriptionJobManager, TranscriptionJobRequest
from earcopy_service.models import Stem
from earcopy_service.presets import PRESET_BY_KEY, create_project


class FakeBackend:
    def capabilities(self):
        raise NotImplementedError

    def load(self, model_path, dtype):
        self.loaded = True

    def transcribe(self, audio_path, instruments, on_event):
        on_event(BackendProgress(completed=0, total=1))
        on_event(
            BackendNoteStart(
                event_index=12,
                instrument_id=instruments[0],
                pitch=64,
                start_sec=0.5,
            )
        )
        on_event(BackendNoteEnd(event_index=12, end_sec=1.0))
        on_event(BackendProgress(completed=1, total=1))

    def unload(self):
        self.loaded = False


class MalformedEventBackend(FakeBackend):
    def transcribe(self, audio_path, instruments, on_event):
        on_event(
            BackendNoteStart(
                event_index=12,
                instrument_id=instruments[0],
                pitch=64,
                start_sec=1.0,
            )
        )
        on_event(BackendNoteEnd(event_index=12, end_sec=0.5))
        on_event(BackendNoteEnd(event_index=999, end_sec=1.5))
        on_event(
            BackendNoteStart(
                event_index=13,
                instrument_id=instruments[0],
                pitch=67,
                start_sec=2.0,
            )
        )


def test_job_publishes_joined_note_progress_and_completion() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    manager = TranscriptionJobManager(
        backend_factory=FakeBackend,
        audio_preparer=lambda path: path,
    )
    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        tracks=project.tracks,
    )

    job_id = manager.start(request)
    assert manager.wait_for_terminal(job_id) == "completed"
    events = [event.data for event in manager.events(job_id)]

    assert [event["status"] for event in events if event["type"] == "state"] == [
        "preparing_audio",
        "loading_model",
        "transcribing",
        "building_project",
        "completed",
    ]
    notes = [event for event in events if event["type"] == "note"]
    assert len(notes) == 1
    assert notes[0]["pitch"] == 64
    assert notes[0]["sourceInstrumentId"] == "violin"
    assert len([event for event in events if event["type"] == "progress"]) == 2


def test_job_recovers_from_malformed_note_events() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    manager = TranscriptionJobManager(
        backend_factory=MalformedEventBackend,
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    events = [event.data for event in manager.events(job_id)]
    notes = [event for event in events if event["type"] == "note"]
    errors = [event for event in events if event["type"] == "error"]

    assert len(notes) == 1
    assert notes[0]["startSec"] == 1.0
    assert notes[0]["endSec"] == 1.01
    assert errors == []


def test_sse_can_resume_after_sequence() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    manager = TranscriptionJobManager(
        backend_factory=FakeBackend,
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            tracks=project.tracks,
        )
    )
    manager.wait_for_terminal(job_id)

    chunks = list(manager.iter_sse(job_id, after_sequence=2))

    assert chunks
    assert all(not chunk.startswith("id: 1\n") for chunk in chunks)
    assert any('"status": "completed"' in chunk for chunk in chunks)


def test_unavailable_backend_fails_without_preparing_audio() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    prepared = False

    def prepare(path):
        nonlocal prepared
        prepared = True
        return path

    manager = TranscriptionJobManager(
        backend_factory=FakeBackend,
        audio_preparer=prepare,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            backend="CUDA",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "failed"
    assert prepared is False
    events = [event.data for event in manager.events(job_id)]
    assert any(
        event["type"] == "error"
        and "CUDA: この配布版には含まれていません" in event["message"]
        for event in events
    )


def test_auto_prefers_cuda_and_publishes_resolved_backend() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    loaded_backends: list[str] = []

    class CudaBackend(FakeBackend):
        def capabilities(self):
            return BackendCapabilities(
                name="CUDA",
                device="cuda",
                dtypes=("float32", "float16"),
                available=True,
            )

        def load(self, model_path, dtype):
            loaded_backends.append("CUDA")

    manager = TranscriptionJobManager(
        backend_factories={"CPU": FakeBackend, "CUDA": CudaBackend},
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            backend="Auto",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert loaded_backends == ["CUDA"]
    assert any(
        event.data
        == {"type": "state", "status": "completed", "backend": "CUDA"}
        for event in manager.events(job_id)
    )


def test_four_stem_job_routes_instruments_and_publishes_stems(tmp_path) -> None:
    project = create_project("stems", PRESET_BY_KEY["anime-song"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[tuple[str, ...]] = []

    class RecordingBackend(FakeBackend):
        def transcribe(self, audio_path, instruments, on_event):
            calls.append(tuple(instruments))
            on_event(BackendProgress(completed=1, total=1))

    def separate(_audio_path, output_directory):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other")
        ]

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="four_stem",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    events = [event.data for event in manager.events(job_id)]
    assert [event["status"] for event in events if event["type"] == "state"] == [
        "preparing_audio",
        "separating",
        "loading_model",
        "transcribing",
        "building_project",
        "completed",
    ]
    assert calls == [
        ("drums", "timpani"),
        ("electric_bass",),
        ("voice",),
        (
            "acoustic_piano",
            "string_ensemble",
            "acoustic_guitar",
            "distorted_electric_guitar",
            "brass_section",
        ),
    ]
    assert len([event for event in events if event["type"] == "stem"]) == 4
