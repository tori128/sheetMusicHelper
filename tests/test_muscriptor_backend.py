from pathlib import Path
from types import SimpleNamespace

import pytest

from earcopy_service.backends import (
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
    CpuMuscriptorBackend,
    CudaMuscriptorBackend,
)


class FakeModel:
    load_arguments = None

    @classmethod
    def load_model(cls, path, device, dtype):
        cls.load_arguments = (path, device, dtype)
        return cls()

    def transcribe(self, audio_path, instruments):
        yield SimpleNamespace(completed=0, total=1)
        yield SimpleNamespace(
            index=3,
            instrument="violin",
            pitch=72,
            start_time=1.25,
        )
        yield SimpleNamespace(start_event_index=3, end_time=1.75)
        yield SimpleNamespace(completed=1, total=1)


def test_cpu_backend_maps_official_muscriptor_events(tmp_path) -> None:
    model_path = tmp_path / "model.safetensors"
    audio_path = tmp_path / "audio.wav"
    model_path.write_bytes(b"model")
    audio_path.write_bytes(b"audio")
    backend = CpuMuscriptorBackend(model_class=FakeModel)
    events = []

    backend.load(model_path, "float32")
    backend.transcribe(audio_path, ["violin"], events.append)

    assert FakeModel.load_arguments == (model_path, "cpu", "float32")
    assert events == [
        BackendProgress(completed=0, total=1),
        BackendNoteStart(
            event_index=3,
            instrument_id="violin",
            pitch=72,
            start_sec=1.25,
        ),
        BackendNoteEnd(event_index=3, end_sec=1.75),
        BackendProgress(completed=1, total=1),
    ]


def test_cpu_backend_refuses_non_local_model_reference() -> None:
    backend = CpuMuscriptorBackend(model_class=FakeModel)

    with pytest.raises(ValueError, match="見つかりません"):
        backend.load(Path("small"), "float32")


class FakeCuda:
    def __init__(self, available: bool) -> None:
        self._available = available
        self.cache_cleared = False

    def is_available(self) -> bool:
        return self._available

    def empty_cache(self) -> None:
        self.cache_cleared = True


def test_cuda_backend_loads_model_on_cuda_and_clears_cache(tmp_path) -> None:
    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")
    cuda = FakeCuda(available=True)
    backend = CudaMuscriptorBackend(
        model_class=FakeModel,
        torch_module=SimpleNamespace(cuda=cuda),
    )

    assert backend.capabilities().available is True
    backend.load(model_path, "float16")
    backend.unload()

    assert FakeModel.load_arguments == (model_path, "cuda", "float16")
    assert cuda.cache_cleared is True


def test_cuda_backend_reports_missing_gpu() -> None:
    backend = CudaMuscriptorBackend(
        model_class=FakeModel,
        torch_module=SimpleNamespace(cuda=FakeCuda(available=False)),
    )

    capability = backend.capabilities()

    assert capability.available is False
    assert capability.unavailable_reason == "対応するNVIDIA GPUが見つかりません"
