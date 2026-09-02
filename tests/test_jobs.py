import hashlib
import threading
from pathlib import Path

import numpy
import pytest
import soundfile

from earcopy_service.backends import (
    BackendCapabilities,
    BackendInvalidChunk,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
)
from earcopy_service.jobs import (
    MAX_RETAINED_TERMINAL_JOBS,
    TranscriptionMethodPolicy,
    TranscriptionJobManager,
    TranscriptionJobRequest,
)
from earcopy_service.models import Note, Stem
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.stem_separation import StemSeparationCancelled
from earcopy_service.transcription_cache import TranscriptionResultCache


class FakeBackend:
    def capabilities(self):
        raise NotImplementedError

    def load(self, model_path, dtype):
        self.loaded = True

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
        self.beam_size = beam_size
        self.prelude_forcing = prelude_forcing
        self.batch_size = batch_size
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


def test_job_request_defaults_to_high_accuracy_and_enabled_postprocessing() -> None:
    project = create_project("defaults", PRESET_BY_KEY["general-band"])

    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        tracks=project.tracks,
    )

    assert request.timing_guide_note_filter is False
    assert request.velocity_from_stem_amplitude is True
    assert request.model_variant == "large"
    assert request.transcription_profile == "high_accuracy"
    assert request.transcription_input_names is None


def test_job_request_accepts_selected_separated_transcription_inputs() -> None:
    project = create_project("selected inputs", PRESET_BY_KEY["general-band"])

    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        mode="separated",
        transcriptionInputNames=["other"],
        tracks=project.tracks,
    )

    assert request.transcription_input_names == frozenset({"other"})


def test_job_request_rejects_selected_inputs_in_direct_mode() -> None:
    project = create_project("direct", PRESET_BY_KEY["general-band"])

    with pytest.raises(ValueError, match="transcriptionInputNames"):
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            mode="direct",
            transcriptionInputNames=["other"],
            tracks=project.tracks,
        )


def test_job_request_rejects_empty_selected_input_list() -> None:
    project = create_project("empty inputs", PRESET_BY_KEY["general-band"])

    with pytest.raises(ValueError, match="at least 1 item"):
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            mode="separated",
            transcriptionInputNames=[],
            tracks=project.tracks,
        )


def test_job_request_limits_timing_reference_collection_to_supported_inputs(
) -> None:
    project = create_project("reference input", PRESET_BY_KEY["general-band"])

    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        mode="separated",
        transcriptionInputNames=["bass"],
        transcriptionInputPass="timing_reference_only",
        tracks=project.tracks,
    )

    assert request.transcription_input_pass == "timing_reference_only"
    with pytest.raises(ValueError, match="does not support inputs"):
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            mode="separated",
            transcriptionInputNames=["vocals"],
            transcriptionInputPass="timing_reference_only",
            tracks=project.tracks,
        )


def test_separated_job_assigns_velocity_from_stem_amplitude(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EARCOPY_USER_DATA", str(tmp_path / "user-data"))
    project = create_project("velocity", PRESET_BY_KEY["general-band"])
    piano_track = next(
        track
        for track in project.tracks
        if track.instrument_id == "acoustic_piano"
    )
    analysis_audio = tmp_path / "analysis.wav"
    analysis_audio.write_bytes(b"analysis")

    class PianoBackend(FakeBackend):
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
            for event_index, start_sec in ((1, 0.0), (2, 0.5)):
                on_event(
                    BackendNoteStart(
                        event_index=event_index,
                        instrument_id="acoustic_piano",
                        pitch=59 + event_index,
                        start_sec=start_sec,
                    )
                )
                on_event(
                    BackendNoteEnd(
                        event_index=event_index,
                        end_sec=start_sec + 0.2,
                    )
                )
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel,
        _progress_callback,
    ):
        output_directory.mkdir(parents=True, exist_ok=True)
        stems = []
        for name in (
            "drums",
            "bass",
            "vocals",
            "other",
            "piano",
            "guitar",
        ):
            path = output_directory / f"{name}.wav"
            audio = numpy.zeros((1_000, 2), dtype=numpy.float32)
            if name == "piano":
                audio[0:200] = 10 ** (-60 / 20)
                audio[500:700] = 10 ** (-6 / 20)
            soundfile.write(path, audio, 1_000, subtype="FLOAT")
            stems.append(
                Stem(type=name, cachePath=str(path), sha256="a" * 64)
            )
        return stems

    manager = TranscriptionJobManager(
        backend_factory=PianoBackend,
        audio_preparer=lambda _path: analysis_audio,
        stem_separator=separate,
    )

    def transcribe(velocity_from_stem_amplitude: bool) -> list[int]:
        job_id = manager.start(
            TranscriptionJobRequest(
                audioPath=str(analysis_audio),
                modelPath="model.safetensors",
                mode="separated",
                drumOnsetGuide=False,
                velocityFromStemAmplitude=velocity_from_stem_amplitude,
                tracks=[piano_track],
            )
        )
        assert manager.wait_for_terminal(job_id) == "completed"
        return [
            event.data["velocity"]
            for event in manager.events(job_id)
            if event.data["type"] == "note"
        ]

    assert transcribe(True) == [1, 127]
    assert transcribe(False) == [100, 100]


def test_job_request_rejects_removed_beam_size() -> None:
    project = create_project("beam-setting", PRESET_BY_KEY["general-band"])

    with pytest.raises(ValueError, match="beamSize"):
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            beamSize=2,
            tracks=project.tracks,
        )


def test_automatic_job_accepts_an_empty_initial_track_list() -> None:
    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        instrumentSelectionMode="automatic",
    )

    assert request.tracks == []


def test_fixed_job_rejects_an_empty_track_list() -> None:
    with pytest.raises(ValueError, match="requires tracks"):
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
        )


def test_timing_guide_filter_uses_unmodified_stem_as_note_support(
    tmp_path,
) -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    bass_track = next(
        track for track in project.tracks if track.instrument_id == "electric_bass"
    )
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[str] = []

    class TimingGuideBackend(FakeBackend):
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
            name = Path(audio_path).name
            calls.append(name)

            def emit(index: int, pitch: int, start: float, end: float) -> None:
                on_event(
                    BackendNoteStart(
                        event_index=index,
                        instrument_id="electric_bass",
                        pitch=pitch,
                        start_sec=start,
                    )
                )
                on_event(BackendNoteEnd(event_index=index, end_sec=end))

            if name == "bass-with-highpassed-drums-g20.wav":
                emit(1, 40, 1.0, 1.1)
                emit(2, 41, 2.0, 2.1)
                emit(3, 43, 3.0, 3.5)
            elif name == "bass.wav":
                emit(1, 41, 2.04, 2.3)
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in (
                "drums",
                "bass",
                "vocals",
                "other",
                "piano",
                "guitar",
            )
        ]

    manager = TranscriptionJobManager(
        backend_factory=TimingGuideBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        weighted_stem_mixer=(
            lambda _sources, _gains, output, _cancel: output
        ),
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            drumOnsetGuide=True,
            timingGuideNoteFilter=True,
            tracks=[bass_track],
        )
    )

    status = manager.wait_for_terminal(job_id)
    events = [event.data for event in manager.events(job_id)]
    assert status == "completed", events
    notes = [event for event in events if event["type"] == "note"]
    partial = next(
        event
        for event in events
        if event["type"] == "partial_result"
        and event.get("inputName") == "bass"
    )
    progress_events = [
        event
        for event in events
        if event["type"] == "progress"
        and event["stage"] == "transcribing"
    ]
    input_results = [
        event
        for event in events
        if event["type"] == "transcription_input_result"
    ]

    assert calls == ["bass-with-highpassed-drums-g20.wav", "bass.wav"]
    assert [
        (
            event["transcriptionInputName"],
            event["transcriptionPass"],
            event["inputPassIndex"],
            event["inputPassCount"],
        )
        for event in progress_events
    ] == [
        ("bass", "drums_added_audio", 1, 2),
        ("bass", "separated_audio", 2, 2),
    ]
    assert [note["pitch"] for note in notes] == [41]
    assert [note["rawStartSec"] for note in notes] == [2.0]
    assert partial["completedPasses"] == 2
    assert partial["totalPasses"] == 2
    assert partial["timingGuideUnmodifiedNoteCount"] == 1
    assert partial["timingGuideNoteDiscardedCount"] == 2
    assert partial["timingGuideNoteMergedCount"] == 0
    assert [result["role"] for result in input_results] == [
        "primary",
        "timing_reference",
    ]
    assert [note["pitch"] for note in input_results[0]["notes"]] == [
        40,
        41,
        43,
    ]
    assert [note["pitch"] for note in input_results[1]["notes"]] == [41]


def test_timing_reference_only_job_transcribes_only_the_unmodified_stem(
    tmp_path,
) -> None:
    project = create_project("missing reference", PRESET_BY_KEY["general-band"])
    bass_track = next(
        track for track in project.tracks if track.instrument_id == "electric_bass"
    )
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[str] = []

    class RecordingBackend(FakeBackend):
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
            calls.append(Path(audio_path).name)
            on_event(
                BackendNoteStart(
                    event_index=1,
                    instrument_id=instruments[0],
                    pitch=41,
                    start_sec=2.0,
                )
            )
            on_event(BackendNoteEnd(event_index=1, end_sec=2.5))
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in (
                "drums",
                "bass",
                "vocals",
                "other",
                "piano",
                "guitar",
            )
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
            mode="separated",
            drumOnsetGuide=True,
            timingGuideNoteFilter=True,
            velocityFromStemAmplitude=False,
            transcriptionInputNames=["bass"],
            transcriptionInputPass="timing_reference_only",
            tracks=[bass_track],
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    events = [event.data for event in manager.events(job_id)]
    assert calls == ["bass.wav"]
    assert not any(event["type"] == "note" for event in events)
    input_results = [
        event
        for event in events
        if event["type"] == "transcription_input_result"
    ]
    assert [
        (
            result["inputName"],
            result["role"],
            result["transcriptionPass"],
        )
        for result in input_results
    ] == [("bass", "timing_reference", "separated_audio")]
    assert [note["pitch"] for note in input_results[0]["notes"]] == [41]

class MalformedEventBackend(FakeBackend):
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


class InvalidChunkBackend(FakeBackend):
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
        on_event(
            BackendNoteStart(
                event_index=12,
                instrument_id=instruments[0],
                pitch=64,
                start_sec=5.25,
            )
        )
        on_event(BackendNoteEnd(event_index=12, end_sec=5.75))
        on_event(
            BackendInvalidChunk(
                chunk_index=1,
                start_sec=5.0,
                end_sec=10.0,
                reason="token limit",
            )
        )
        on_event(BackendProgress(completed=2, total=2))


def test_job_publishes_joined_note_progress_and_completion() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    backends = []

    def create_backend():
        backend = FakeBackend()
        backends.append(backend)
        return backend

    manager = TranscriptionJobManager(
        backend_factory=create_backend,
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
    assert next(
        backend.beam_size
        for backend in backends
        if hasattr(backend, "beam_size")
    ) == 1
    inference_backend = next(
        backend for backend in backends if hasattr(backend, "batch_size")
    )
    assert inference_backend.prelude_forcing is True
    assert inference_backend.batch_size == 1


@pytest.mark.parametrize(
    ("model_variant", "expected_batch_size"),
    (("large", 2), ("medium", 8), ("small", 16)),
)
def test_fast_cuda_profile_uses_model_specific_batch_size(
    model_variant,
    expected_batch_size,
) -> None:
    project = create_project("fast", PRESET_BY_KEY["string-quartet"])
    backends = []

    def create_backend():
        backend = FakeBackend()
        backends.append(backend)
        return backend

    manager = TranscriptionJobManager(
        backend_factories={"CUDA": create_backend},
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            modelVariant=model_variant,
            backend="CUDA",
            transcriptionProfile="fast",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    inference_backend = next(
        backend for backend in backends if hasattr(backend, "batch_size")
    )
    assert inference_backend.prelude_forcing is False
    assert inference_backend.batch_size == expected_batch_size


def test_fast_cpu_profile_uses_batch_size_one() -> None:
    project = create_project("fast cpu", PRESET_BY_KEY["string-quartet"])
    backends = []

    def create_backend():
        backend = FakeBackend()
        backends.append(backend)
        return backend

    manager = TranscriptionJobManager(
        backend_factory=create_backend,
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            modelVariant="small",
            backend="CPU",
            transcriptionProfile="fast",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    inference_backend = next(
        backend for backend in backends if hasattr(backend, "batch_size")
    )
    assert inference_backend.prelude_forcing is False
    assert inference_backend.batch_size == 1


def test_direct_job_publishes_each_completed_chunk_before_finishing() -> None:
    project = create_project("preview", PRESET_BY_KEY["string-quartet"])

    class ChunkedBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            for completed, (pitch, start_sec) in enumerate(
                ((60, 0.0), (64, 5.0)),
                start=1,
            ):
                on_event(
                    BackendNoteStart(
                        event_index=completed,
                        instrument_id=instruments[0],
                        pitch=pitch,
                        start_sec=start_sec,
                    )
                )
                on_event(
                    BackendNoteEnd(
                        event_index=completed,
                        end_sec=start_sec + 1.0,
                    )
                )
                on_event(BackendProgress(completed=completed, total=2))

    manager = TranscriptionJobManager(
        backend_factory=ChunkedBackend,
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
    note_indexes = [
        index for index, event in enumerate(events) if event["type"] == "note"
    ]
    progress_indexes = [
        index
        for index, event in enumerate(events)
        if event["type"] == "progress"
    ]

    assert [events[index]["pitch"] for index in note_indexes] == [60, 64]
    assert len(progress_indexes) == 2
    assert note_indexes[0] < progress_indexes[0] < note_indexes[1]
    assert note_indexes[1] < progress_indexes[1]


def test_direct_preview_removes_notes_rejected_by_later_context() -> None:
    project = create_project("preview-cleanup", PRESET_BY_KEY["string-quartet"])

    class PathologicalChainBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            for completed, (start_sec, end_sec) in enumerate(
                ((0.0, 6.0), (5.5, 11.0)),
                start=1,
            ):
                on_event(
                    BackendNoteStart(
                        event_index=completed,
                        instrument_id=instruments[0],
                        pitch=60,
                        start_sec=start_sec,
                    )
                )
                on_event(
                    BackendNoteEnd(
                        event_index=completed,
                        end_sec=end_sec,
                    )
                )
                on_event(BackendProgress(completed=completed, total=2))

    manager = TranscriptionJobManager(
        backend_factory=PathologicalChainBackend,
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
    preview_note = next(event for event in events if event["type"] == "note")
    cleanup = next(
        event for event in events if event["type"] == "note_cleanup"
    )

    assert cleanup["removedNoteIds"] == [preview_note["id"]]


def test_second_identical_job_reuses_pre_routing_transcription(
    tmp_path: Path,
) -> None:
    project = create_project("cache", PRESET_BY_KEY["string-quartet"])
    audio = tmp_path / "audio.wav"
    model = tmp_path / "model.safetensors"
    audio.write_bytes(b"audio")
    model.write_bytes(b"model")
    backends = []

    def create_backend():
        backend = FakeBackend()
        backends.append(backend)
        return backend

    manager = TranscriptionJobManager(
        backend_factory=create_backend,
        audio_preparer=lambda path: path,
        transcription_cache=TranscriptionResultCache(
            tmp_path / "transcriptions"
        ),
    )
    request = TranscriptionJobRequest(
        audioPath=str(audio),
        modelPath=str(model),
        tracks=project.tracks,
    )

    first_id = manager.start(request)
    assert manager.wait_for_terminal(first_id) == "completed"
    second_id = manager.start(request)
    assert manager.wait_for_terminal(second_id) == "completed"

    assert len(backends) == 4
    assert sum(hasattr(backend, "beam_size") for backend in backends) == 1
    first_notes = [
        event.data
        for event in manager.events(first_id)
        if event.data["type"] == "note"
    ]
    second_notes = [
        event.data
        for event in manager.events(second_id)
        if event.data["type"] == "note"
    ]
    assert [note["pitch"] for note in second_notes] == [
        note["pitch"] for note in first_notes
    ]
    second_partial = next(
        event.data
        for event in manager.events(second_id)
        if event.data["type"] == "partial_result"
    )
    assert second_partial["cacheHit"] is True


def test_direct_automatic_job_creates_tracks_from_model_output() -> None:
    received_instruments: list[list[str] | None] = []

    class AutomaticBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            received_instruments.append(instruments)
            for event_index, (instrument_id, pitch) in enumerate(
                (("electric_piano", 60), ("acoustic_bass", 40))
            ):
                on_event(
                    BackendNoteStart(
                        event_index=event_index,
                        instrument_id=instrument_id,
                        pitch=pitch,
                        start_sec=float(event_index),
                    )
                )
                on_event(
                    BackendNoteEnd(
                        event_index=event_index,
                        end_sec=float(event_index) + 0.5,
                    )
                )
            on_event(BackendProgress(completed=1, total=1))

    manager = TranscriptionJobManager(
        backend_factory=AutomaticBackend,
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            instrumentSelectionMode="automatic",
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    events = [event.data for event in manager.events(job_id)]
    tracks = [event["track"] for event in events if event["type"] == "track"]
    notes = [event for event in events if event["type"] == "note"]
    assert received_instruments == [None]
    assert [track["instrumentId"] for track in tracks] == [
        "electric_piano",
        "acoustic_bass",
    ]
    assert [track["midiChannel"] for track in tracks] == [1, 2]
    assert [note["trackId"] for note in notes] == [
        track["id"] for track in tracks
    ]


def test_direct_fixed_job_maps_related_candidates_to_selected_tracks() -> None:
    project = create_project("fixed", PRESET_BY_KEY["general-band"])
    bass_track = next(
        track
        for track in project.tracks
        if track.instrument_id == "electric_bass"
    )
    received_candidates: list[tuple[str, ...]] = []

    class RelatedBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            received_candidates.append(tuple(instruments))
            for event_index, instrument_id in enumerate(
                ("electric_bass", "acoustic_bass")
            ):
                on_event(
                    BackendNoteStart(
                        event_index=event_index,
                        instrument_id=instrument_id,
                        pitch=40,
                        start_sec=1.0,
                    )
                )
                on_event(
                    BackendNoteEnd(
                        event_index=event_index,
                        end_sec=1.5,
                    )
                )
            on_event(BackendProgress(completed=1, total=1))

    manager = TranscriptionJobManager(
        backend_factory=RelatedBackend,
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
    assert set(received_candidates[0]) >= {
        "acoustic_piano",
        "electric_piano",
        "acoustic_guitar",
        "clean_electric_guitar",
        "distorted_electric_guitar",
        "acoustic_bass",
        "electric_bass",
        "contrabass",
    }
    notes = [
        event.data
        for event in manager.events(job_id)
        if event.data["type"] == "note"
    ]
    assert len(notes) == 1
    assert notes[0]["sourceInstrumentId"] == "electric_bass"
    assert notes[0]["trackId"] == str(bass_track.id)


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

    assert notes == []
    assert errors == []


def test_job_discards_notes_from_invalid_muscriptor_chunk() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    manager = TranscriptionJobManager(
        backend_factory=InvalidChunkBackend,
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
    assert [event for event in events if event["type"] == "note"] == []
    partial = next(
        event for event in events if event["type"] == "partial_result"
    )
    assert partial["invalidChunkCount"] == 1
    assert partial["invalidChunkDiscardedNoteCount"] == 1


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
    job = manager._get(job_id)

    class SliceOnlyEvents(list):
        def __iter__(self):
            raise AssertionError("SSE resume must not scan prior events")

    job.events = SliceOnlyEvents(job.events)

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
    loaded_backends: list[tuple[str, str]] = []

    class CudaBackend(FakeBackend):
        def capabilities(self):
            return BackendCapabilities(
                name="CUDA",
                device="cuda",
                dtypes=("float32", "float16"),
                available=True,
            )

        def load(self, model_path, dtype):
            loaded_backends.append(("CUDA", dtype))

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
    assert loaded_backends == [("CUDA", "float16")]
    assert any(
        event.data
        == {"type": "state", "status": "completed", "backend": "CUDA"}
        for event in manager.events(job_id)
    )


def test_auto_cpu_fallback_uses_float32_for_fp16_request() -> None:
    project = create_project("job", PRESET_BY_KEY["string-quartet"])
    loaded_dtypes: list[str] = []

    class CpuBackend(FakeBackend):
        def load(self, model_path, dtype):
            loaded_dtypes.append(dtype)

    manager = TranscriptionJobManager(
        backend_factories={"CPU": CpuBackend},
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            dtype="float16",
            backend="Auto",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert loaded_dtypes == ["float32"]


def test_separated_job_routes_foreground_stems_independently_and_publishes_stems(
    tmp_path,
) -> None:
    project = create_project("stems", PRESET_BY_KEY["anime-song"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[tuple[str, tuple[str, ...], int]] = []
    mixed_sources: list[str] = []

    class RecordingBackend(FakeBackend):
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
            call_index = len(calls)
            calls.append(
                (str(audio_path), tuple(instruments), beam_size)
            )
            on_event(
                BackendNoteStart(
                    event_index=0,
                    instrument_id=instruments[0],
                    pitch=60 + call_index,
                    start_sec=float(call_index),
                )
            )
            on_event(
                BackendNoteEnd(
                    event_index=0,
                    end_sec=float(call_index) + 0.5,
                )
            )
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        progress_callback,
    ):
        progress_callback(0, 4)
        progress_callback(1, 4)
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    def mix(source_paths, output_path, _cancel_check):
        mixed_sources.extend(path.name for path in source_paths)
        return output_path

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=mix,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
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
    assert [
        (event["stage"], event["completed"], event["total"])
        for event in events
        if event["type"] == "progress" and event["stage"] == "separating"
    ] == [("separating", 0, 4), ("separating", 1, 4)]
    all_candidates = (
        "acoustic_piano",
        "electric_piano",
        "string_ensemble",
        "acoustic_guitar",
        "distorted_electric_guitar",
        "clean_electric_guitar",
        "acoustic_bass",
        "electric_bass",
        "contrabass",
        "drums",
        "timpani",
        "voice",
        "brass_section",
    )
    assert [instruments for _audio_path, instruments, _beam in calls] == [
        ("drums",),
        ("electric_bass", "acoustic_bass", "contrabass"),
        ("acoustic_piano", "electric_piano"),
        (
            "acoustic_guitar",
            "distorted_electric_guitar",
            "clean_electric_guitar",
        ),
        ("voice",),
        (
            "timpani",
            "string_ensemble",
            "brass_section",
        ),
    ]
    assert [Path(path).name for path, _instruments, _beam in calls] == [
        "drums.wav",
        "bass.wav",
        "piano.wav",
        "guitar.wav",
        "vocals.wav",
        "other.wav",
    ]
    assert [beam for _path, _instruments, beam in calls] == [1] * 6
    assert mixed_sources == []
    routed_parts = tuple(
        instrument
        for _audio_path, instruments, _beam in calls
        for instrument in instruments
    )
    assert sorted(routed_parts) == sorted(all_candidates)
    assert len(routed_parts) == len(set(routed_parts))
    assert len([event for event in events if event["type"] == "stem"]) == 6
    assert [
        event["pitch"] for event in events if event["type"] == "note"
    ] == [60, 61, 62, 63, 64, 65]
    assert len(
        [event for event in events if event["type"] == "partial_result"]
    ) == 6

def test_separated_bass_uses_filtered_drum_audio_without_forced_alignment(
    tmp_path: Path,
) -> None:
    project = create_project("bass-alignment", PRESET_BY_KEY["anime-song"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    mixed_inputs: list[str] = []

    class BassAlignmentBackend(FakeBackend):
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
            input_name = Path(audio_path).name
            if input_name == "drums.wav":
                instrument_id, pitch, start_sec, end_sec = (
                    "drums",
                    36,
                    1.0,
                    1.01,
                )
            elif input_name == "bass-with-highpassed-drums-g20.wav":
                instrument_id, pitch, start_sec, end_sec = (
                    "electric_bass",
                    40,
                    0.95,
                    1.45,
                )
            else:
                instrument_id, pitch, start_sec, end_sec = (
                    instruments[0],
                    60,
                    3.0,
                    3.5,
                )
            on_event(
                BackendNoteStart(
                    event_index=0,
                    instrument_id=instrument_id,
                    pitch=pitch,
                    start_sec=start_sec,
                )
            )
            on_event(BackendNoteEnd(event_index=0, end_sec=end_sec))
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    def weighted_mix(source_paths, _gains, output_path, _cancel_check):
        mixed_inputs.append(source_paths[0].name)
        return output_path

    manager = TranscriptionJobManager(
        backend_factory=BassAlignmentBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        weighted_stem_mixer=weighted_mix,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            drumOnsetGuide=True,
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    events = [event.data for event in manager.events(job_id)]
    bass_notes = [
        event
        for event in events
        if event["type"] == "note"
        and event["sourceInstrumentId"] == "electric_bass"
    ]
    assert len(bass_notes) == 1
    assert bass_notes[0]["rawStartSec"] == pytest.approx(0.95)
    assert bass_notes[0]["rawEndSec"] == pytest.approx(1.45)
    assert "bass.wav" in mixed_inputs
def test_separated_job_keeps_piano_in_dedicated_and_other_routes(
    tmp_path,
) -> None:
    project = create_project("components", PRESET_BY_KEY["anime-song"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[tuple[str, tuple[str, ...], int]] = []
    mixed_sources: list[tuple[str, ...]] = []

    class RecordingBackend(FakeBackend):
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
            calls.append((str(audio_path), tuple(instruments), beam_size))
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    def mix(source_paths, output_path, _cancel_check):
        mixed_sources.append(tuple(path.name for path in source_paths))
        return output_path

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=mix,
        weighted_stem_mixer=(
            lambda _sources, _gains, output, _cancel: output
        ),
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert [instruments for _path, instruments, _beam in calls] == [
        ("drums",),
        ("electric_bass", "acoustic_bass", "contrabass"),
        ("acoustic_piano", "electric_piano"),
        (
            "acoustic_guitar",
            "distorted_electric_guitar",
            "clean_electric_guitar",
        ),
        ("voice",),
        (
            "timpani",
            "string_ensemble",
            "brass_section",
        ),
    ]
    assert [Path(path).name for path, _instruments, _beam in calls] == [
        "drums.wav",
        "bass.wav",
        "piano.wav",
        "guitar.wav",
        "vocals.wav",
        "other.wav",
    ]
    assert [beam for _path, _instruments, beam in calls] == [
        1,
        1,
        1,
        1,
        1,
        1,
    ]
    assert mixed_sources == []


def test_component_candidate_order_is_independent_of_track_display_order(
    tmp_path,
) -> None:
    project = create_project("components", PRESET_BY_KEY["anime-song"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    candidates: list[tuple[str, ...]] = []

    class RecordingBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            candidates.append(tuple(instruments))
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=lambda _sources, output, _cancel: output,
        weighted_stem_mixer=(
            lambda _sources, _gains, output, _cancel: output
        ),
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            tracks=list(reversed(project.tracks)),
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert candidates == [
        ("drums",),
        ("electric_bass", "acoustic_bass", "contrabass"),
        ("acoustic_piano", "electric_piano"),
        (
            "acoustic_guitar",
            "distorted_electric_guitar",
            "clean_electric_guitar",
        ),
        ("voice",),
        (
            "timpani",
            "string_ensemble",
            "brass_section",
        ),
    ]


def test_separated_automatic_job_limits_candidates_by_component(
    tmp_path,
) -> None:
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    candidates: list[tuple[str, ...] | None] = []

    class RecordingBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            candidates.append(
                None if instruments is None else tuple(instruments)
            )
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=lambda _sources, output, _cancel: output,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            instrumentSelectionMode="automatic",
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert candidates[:5] == [
        ("drums",),
        ("acoustic_bass", "electric_bass", "contrabass"),
        ("acoustic_piano", "electric_piano"),
        (
            "acoustic_guitar",
            "clean_electric_guitar",
            "distorted_electric_guitar",
        ),
        ("voice",),
    ]
    remainder = candidates[5]
    assert remainder is not None
    assert "string_ensemble" in remainder
    assert not set(remainder) & {
        "drums",
        "acoustic_bass",
        "electric_bass",
        "contrabass",
        "voice",
        "acoustic_piano",
        "electric_piano",
        "acoustic_guitar",
        "clean_electric_guitar",
        "distorted_electric_guitar",
    }


def test_related_instrument_predictions_use_existing_family_tracks(
    tmp_path,
) -> None:
    project = create_project("families", PRESET_BY_KEY["anime-song"])
    tracks = {track.instrument_id: track.id for track in project.tracks}
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")

    class RelatedInstrumentBackend(FakeBackend):
        def transcribe(
            self,
            _audio_path,
            instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            candidates = set(instruments)
            instrument_id = next(
                (
                    candidate
                    for candidate in (
                        "acoustic_bass",
                        "electric_piano",
                        "clean_electric_guitar",
                    )
                    if candidate in candidates
                ),
                None,
            )
            if instrument_id is not None:
                on_event(
                    BackendNoteStart(
                        event_index=0,
                        instrument_id=instrument_id,
                        pitch=60,
                        start_sec=0.5,
                    )
                )
                on_event(BackendNoteEnd(event_index=0, end_sec=1.0))
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    manager = TranscriptionJobManager(
        backend_factory=RelatedInstrumentBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=lambda _sources, output, _cancel: output,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    notes = [
        event.data
        for event in manager.events(job_id)
        if event.data["type"] == "note"
    ]
    assert [
        (note["sourceInstrumentId"], note["trackId"]) for note in notes
    ] == [
        ("acoustic_bass", str(tracks["electric_bass"])),
        ("electric_piano", str(tracks["acoustic_piano"])),
        (
            "clean_electric_guitar",
            str(tracks["distorted_electric_guitar"]),
        ),
    ]


def test_remainder_route_includes_unclaimed_components_for_all_candidates(
    tmp_path,
) -> None:
    project = create_project("components", PRESET_BY_KEY["string-quartet"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[tuple[str, tuple[str, ...], int]] = []
    mixed_sources: list[str] = []

    class RecordingBackend(FakeBackend):
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
            calls.append((str(audio_path), tuple(instruments), beam_size))
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    def mix(source_paths, output_path, _cancel_check):
        mixed_sources.extend(path.name for path in source_paths)
        return output_path

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=mix,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert len(calls) == 1
    assert calls[0][1] == ("violin", "viola", "cello")
    assert calls[0][2] == 1
    assert Path(calls[0][0]).name == (
        "other-with-piano-guitar.wav"
    )
    assert mixed_sources == [
        "other.wav",
        "piano.wav",
        "guitar.wav",
    ]


def test_context_guides_use_requested_stems_and_gains(tmp_path) -> None:
    project = create_project("guide", PRESET_BY_KEY["anime-song"])
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")
    calls: list[str] = []
    guide_calls: list[tuple[tuple[str, ...], tuple[float, ...], str]] = []

    class RecordingBackend(FakeBackend):
        def transcribe(
            self,
            audio_path,
            _instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            calls.append(Path(audio_path).name)
            on_event(BackendProgress(completed=1, total=1))

    def separate(
        _audio_path,
        output_directory,
        _model_directory,
        _cancel_check,
        _progress_callback,
    ):
        return [
            Stem(
                type=name,
                cachePath=str(output_directory / f"{name}.wav"),
                sha256="a" * 64,
            )
            for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
        ]

    def weighted_mix(sources, gains, output, _cancel):
        guide_calls.append(
            (
                tuple(source.name for source in sources),
                tuple(gains),
                output.name,
            )
        )
        return output

    manager = TranscriptionJobManager(
        backend_factory=RecordingBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
        stem_mixer=lambda _sources, output, _cancel: output,
        weighted_stem_mixer=weighted_mix,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            drumOnsetGuide=True,
            tracks=project.tracks,
        )
    )

    assert manager.wait_for_terminal(job_id) == "completed"
    assert calls == [
        "drums.wav",
        "bass-with-highpassed-drums-g20.wav",
        "bass.wav",
        "piano-with-drums-g20.wav",
        "piano.wav",
        "guitar-with-drums-g20.wav",
        "guitar.wav",
        "vocals-with-drums-g20.wav",
        "other-with-drums-g20.wav",
        "other.wav",
    ]
    assert guide_calls == [
        (
            ("bass.wav", "drums.wav"),
            (1.0, 0.2),
            "bass-with-highpassed-drums-g20.wav",
        ),
        (
            (
                "piano.wav",
                "drums.wav",
            ),
            (1.0, 0.2),
            "piano-with-drums-g20.wav",
        ),
        (
            ("guitar.wav", "drums.wav"),
            (1.0, 0.2),
            "guitar-with-drums-g20.wav",
        ),
        (
            ("vocals.wav", "drums.wav"),
            (1.0, 0.2),
            "vocals-with-drums-g20.wav",
        ),
        (
            ("other.wav", "drums.wav"),
            (1.0, 0.2),
            "other-with-drums-g20.wav",
        ),
    ]


def test_separated_job_cancels_during_source_separation(tmp_path) -> None:
    project = create_project("cancel stems", PRESET_BY_KEY["anime-song"])
    separation_started = threading.Event()
    audio = tmp_path / "analysis.wav"
    audio.write_bytes(b"analysis")

    def separate(
        _audio_path,
        _output_directory,
        _model_directory,
        cancel_check,
        _progress_callback,
    ):
        separation_started.set()
        while not cancel_check():
            threading.Event().wait(timeout=0.01)
        raise StemSeparationCancelled

    manager = TranscriptionJobManager(
        backend_factory=FakeBackend,
        audio_preparer=lambda _path: audio,
        stem_separator=separate,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath=str(audio),
            modelPath="model.safetensors",
            mode="separated",
            tracks=project.tracks,
        )
    )

    assert separation_started.wait(timeout=5)
    assert manager.cancel(job_id) == "separating"
    assert manager.wait_for_terminal(job_id) == "cancelled"
    assert not any(
        event.data.get("status") == "loading_model"
        for event in manager.events(job_id)
    )


def test_job_cancels_while_preparing_audio() -> None:
    project = create_project("cancel prepare", PRESET_BY_KEY["string-quartet"])
    preparation_started = threading.Event()
    release_preparation = threading.Event()

    def prepare(path):
        preparation_started.set()
        assert release_preparation.wait(timeout=5)
        return path

    manager = TranscriptionJobManager(
        backend_factory=FakeBackend,
        audio_preparer=prepare,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            tracks=project.tracks,
        )
    )

    assert preparation_started.wait(timeout=5)
    assert manager.cancel(job_id) == "preparing_audio"
    release_preparation.set()
    assert manager.wait_for_terminal(job_id) == "cancelled"
    states = [
        event.data.get("status") for event in manager.events(job_id)
    ]
    assert "loading_model" not in states


def test_job_cancels_while_loading_model() -> None:
    project = create_project("cancel load", PRESET_BY_KEY["string-quartet"])
    loading_started = threading.Event()
    release_loading = threading.Event()
    backend_instances = []

    class BlockingLoadBackend(FakeBackend):
        def __init__(self):
            self.unloaded = False
            backend_instances.append(self)

        def load(self, model_path, dtype):
            loading_started.set()
            assert release_loading.wait(timeout=5)

        def unload(self):
            self.unloaded = True

    manager = TranscriptionJobManager(
        backend_factory=BlockingLoadBackend,
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            tracks=project.tracks,
        )
    )

    assert loading_started.wait(timeout=5)
    assert manager.cancel(job_id) == "loading_model"
    release_loading.set()
    assert manager.wait_for_terminal(job_id) == "cancelled"
    assert not any(
        event.data.get("status") == "transcribing"
        for event in manager.events(job_id)
    )
    assert backend_instances[-1].unloaded is True


def test_job_cancels_when_transcription_returns_without_an_event() -> None:
    project = create_project(
        "cancel transcription",
        PRESET_BY_KEY["string-quartet"],
    )
    transcription_started = threading.Event()
    release_transcription = threading.Event()
    backend_instances = []

    class BlockingTranscriptionBackend(FakeBackend):
        def __init__(self):
            self.unloaded = False
            backend_instances.append(self)

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
            transcription_started.set()
            assert release_transcription.wait(timeout=5)

        def unload(self):
            self.unloaded = True

    manager = TranscriptionJobManager(
        backend_factory=BlockingTranscriptionBackend,
        audio_preparer=lambda path: path,
    )
    job_id = manager.start(
        TranscriptionJobRequest(
            audioPath="audio.wav",
            modelPath="model.safetensors",
            tracks=project.tracks,
        )
    )

    assert transcription_started.wait(timeout=5)
    assert manager.cancel(job_id) == "transcribing"
    release_transcription.set()
    assert manager.wait_for_terminal(job_id) == "cancelled"
    assert not any(
        event.data.get("status") == "building_project"
        for event in manager.events(job_id)
    )
    assert backend_instances[-1].unloaded is True


def test_job_cancels_while_building_project() -> None:
    project = create_project("cancel build", PRESET_BY_KEY["string-quartet"])
    building_started = threading.Event()
    release_building = threading.Event()

    class BlockingBuildManager(TranscriptionJobManager):
        def _set_status(self, job, status, backend=None):
            super()._set_status(job, status, backend)
            if status == "building_project":
                building_started.set()
                assert release_building.wait(timeout=5)

    manager = BlockingBuildManager(
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

    assert building_started.wait(timeout=5)
    assert manager.cancel(job_id) == "building_project"
    release_building.set()
    assert manager.wait_for_terminal(job_id) == "cancelled"
    assert not any(
        event.data.get("status") == "completed"
        for event in manager.events(job_id)
    )


def test_jobs_run_serially_to_avoid_overlapping_model_or_gpu_use() -> None:
    project = create_project("serial", PRESET_BY_KEY["string-quartet"])
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    transcription_count = 0
    count_lock = threading.Lock()

    class BlockingBackend(FakeBackend):
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
            nonlocal transcription_count
            with count_lock:
                transcription_count += 1
                current = transcription_count
            if current == 1:
                first_started.set()
                assert release_first.wait(timeout=5)
            else:
                second_started.set()

    manager = TranscriptionJobManager(
        backend_factory=BlockingBackend,
        audio_preparer=lambda path: path,
    )
    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        tracks=project.tracks,
    )

    first_job = manager.start(request)
    assert first_started.wait(timeout=5)
    second_job = manager.start(request)
    assert not second_started.wait(timeout=0.2)

    release_first.set()
    assert manager.wait_for_terminal(first_job) == "completed"
    assert manager.wait_for_terminal(second_job) == "completed"
    assert second_started.is_set()


def test_cancelled_waiting_job_never_loads_or_transcribes() -> None:
    project = create_project("cancel waiting", PRESET_BY_KEY["string-quartet"])
    first_started = threading.Event()
    release_first = threading.Event()
    transcription_count = 0

    class BlockingBackend(FakeBackend):
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
            nonlocal transcription_count
            transcription_count += 1
            first_started.set()
            assert release_first.wait(timeout=5)

    manager = TranscriptionJobManager(
        backend_factory=BlockingBackend,
        audio_preparer=lambda path: path,
    )
    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        tracks=project.tracks,
    )

    first_job = manager.start(request)
    assert first_started.wait(timeout=5)
    waiting_job = manager.start(request)
    assert manager.cancel(waiting_job) == "waiting"

    release_first.set()
    assert manager.wait_for_terminal(first_job) == "completed"
    assert manager.wait_for_terminal(waiting_job) == "cancelled"
    assert transcription_count == 1


def test_completed_job_history_is_bounded() -> None:
    project = create_project("history", PRESET_BY_KEY["string-quartet"])
    manager = TranscriptionJobManager(
        backend_factory=FakeBackend,
        audio_preparer=lambda path: path,
    )
    request = TranscriptionJobRequest(
        audioPath="audio.wav",
        modelPath="model.safetensors",
        tracks=project.tracks,
    )
    job_ids = []

    for _ in range(MAX_RETAINED_TERMINAL_JOBS + 2):
        job_id = manager.start(request)
        assert manager.wait_for_terminal(job_id) == "completed"
        job_ids.append(job_id)

    for expired_job_id in job_ids[:-MAX_RETAINED_TERMINAL_JOBS]:
        with pytest.raises(KeyError, match="採譜ジョブが見つかりません"):
            manager.status(expired_job_id)
    for retained_job_id in job_ids[-MAX_RETAINED_TERMINAL_JOBS:]:
        assert manager.status(retained_job_id) == "completed"
