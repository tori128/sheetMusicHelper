from pathlib import Path
from types import SimpleNamespace
import warnings

import pytest

import earcopy_service.backends.muscriptor as muscriptor_backend
from earcopy_service.backends import (
    BackendNoteEnd,
    BackendNoteStart,
    BackendInvalidChunk,
    BackendProgress,
    CpuMuscriptorBackend,
    CudaMuscriptorBackend,
)


class FakeModel:
    load_arguments = None
    transcribe_arguments = None

    @classmethod
    def load_model(cls, path, device, dtype):
        cls.load_arguments = (path, device, dtype)
        return cls()

    def transcribe(
        self,
        audio_path,
        instruments,
        prelude_forcing,
        batch_size,
        beam_size,
    ):
        type(self).transcribe_arguments = (
            audio_path,
            instruments,
            prelude_forcing,
            batch_size,
            beam_size,
        )
        yield SimpleNamespace(completed=0, total=1)
        yield SimpleNamespace(
            index=3,
            instrument="violin",
            pitch=72,
            start_time=1.25,
        )
        yield SimpleNamespace(start_event_index=3, end_time=1.75)
        yield SimpleNamespace(completed=1, total=1)


class FakeGenerationStep:
    def __init__(self, *token_ids: int) -> None:
        self._token_ids = list(token_ids)

    def tolist(self):
        return list(self._token_ids)

    def clone(self):
        return FakeGenerationStep(*self._token_ids)


class CountingGenerationStep(FakeGenerationStep):
    def __init__(self, *token_ids: int) -> None:
        super().__init__(*token_ids)
        self.tolist_calls = 0

    def tolist(self):
        self.tolist_calls += 1
        return super().tolist()

    def clone(self):
        raise AssertionError("generation steps must not be cloned")


def generation_vocab():
    return [
        SimpleNamespace(type="special", value=0),
        SimpleNamespace(type="tie", value=0),
        SimpleNamespace(type="shift", value=0),
        SimpleNamespace(type="shift", value=1),
        SimpleNamespace(type="program", value=0),
        SimpleNamespace(type="velocity", value=1),
        SimpleNamespace(type="pitch", value=60),
        SimpleNamespace(type="pitch", value=61),
    ]


def test_generation_guard_allows_seven_exact_note_repetitions() -> None:
    guard = muscriptor_backend._TokenGenerationGuard(generation_vocab())

    guard.observe([1], track_duplicates=True)
    guard.observe([2], track_duplicates=True)
    guard.observe([4], track_duplicates=True)
    guard.observe([5], track_duplicates=True)
    for _ in range(7):
        guard.observe([6], track_duplicates=True)


def test_generation_guard_rejects_eight_exact_note_repetitions() -> None:
    guard = muscriptor_backend._TokenGenerationGuard(generation_vocab())

    guard.observe([1], track_duplicates=True)
    guard.observe([2], track_duplicates=True)
    guard.observe([4], track_duplicates=True)
    guard.observe([5], track_duplicates=True)
    for _ in range(7):
        guard.observe([6], track_duplicates=True)

    with pytest.raises(
        muscriptor_backend._RunawayGeneration,
        match="same onset, instrument, and pitch",
    ):
        guard.observe([6], track_duplicates=True)


def test_generation_guard_counts_exact_repetitions_per_musical_time() -> None:
    guard = muscriptor_backend._TokenGenerationGuard(generation_vocab())

    guard.observe([1], track_duplicates=True)
    guard.observe([2], track_duplicates=True)
    guard.observe([4], track_duplicates=True)
    guard.observe([5], track_duplicates=True)
    for _ in range(7):
        guard.observe([6], track_duplicates=True)
    guard.observe([3], track_duplicates=True)
    for _ in range(7):
        guard.observe([6], track_duplicates=True)


def test_generation_guard_rejects_320_steps_without_time_progress() -> None:
    guard = muscriptor_backend._TokenGenerationGuard(generation_vocab())

    guard.observe([1], track_duplicates=False)
    guard.observe([2], track_duplicates=False)
    for _ in range(319):
        guard.observe([4], track_duplicates=False)

    with pytest.raises(
        muscriptor_backend._RunawayGeneration,
        match="320 generation steps",
    ):
        guard.observe([4], track_duplicates=False)


def test_generation_guard_rejects_repetition_shared_by_all_beams() -> None:
    guard = muscriptor_backend._TokenGenerationGuard(generation_vocab())

    guard.observe([1, 1], track_duplicates=False)
    guard.observe([2, 2], track_duplicates=False)
    for _ in range(7):
        guard.observe([6, 6], track_duplicates=False)

    with pytest.raises(
        muscriptor_backend._RunawayGeneration,
        match="all beam candidates",
    ):
        guard.observe([6, 6], track_duplicates=False)


def test_guarded_generation_retries_without_leaking_partial_tokens() -> None:
    vocab = generation_vocab()
    conditions = [object()]

    class FakeLmModel:
        def __init__(self) -> None:
            self.calls = []

        def generate(self, *args, **kwargs):
            self.calls.append((args, dict(kwargs)))
            if kwargs["forbidden_tokens"] is not None:
                for token_id in [1, 2, 4, 5, *([6] * 8)]:
                    yield FakeGenerationStep(token_id)
                return
            for token_id in [1, 2, 7, 0]:
                yield FakeGenerationStep(token_id)

    lm_model = FakeLmModel()
    model = SimpleNamespace(
        _model=lm_model,
        _tokenizer=SimpleNamespace(_vocab=vocab),
    )

    with muscriptor_backend._guarded_muscriptor_generation(model):
        steps = list(
            lm_model.generate(
                conditions=conditions,
                early_stop_on_token=0,
                max_gen_len=2000,
                beam_size=1,
                forbidden_tokens=[99],
            )
        )

    assert [step.tolist() for step in steps] == [[1], [2], [7], [0]]
    assert len(lm_model.calls) == 2
    assert lm_model.calls[0][1]["conditions"] is conditions
    assert lm_model.calls[0][1]["forbidden_tokens"] == [99]
    assert lm_model.calls[1][1]["conditions"] is conditions
    assert lm_model.calls[1][1]["beam_size"] == 1
    assert lm_model.calls[1][1]["forbidden_tokens"] is None


def test_guarded_generation_transfers_each_source_step_once() -> None:
    vocab = generation_vocab()

    class FakeLmModel:
        def __init__(self) -> None:
            self.steps = [
                CountingGenerationStep(1),
                CountingGenerationStep(0),
                CountingGenerationStep(7),
            ]
            self.generate_arguments = None

        def generate(self, *args, **kwargs):
            self.generate_arguments = (args, dict(kwargs))
            yield from self.steps

    lm_model = FakeLmModel()
    model = SimpleNamespace(
        _model=lm_model,
        _tokenizer=SimpleNamespace(_vocab=vocab),
    )

    with muscriptor_backend._guarded_muscriptor_generation(model):
        steps = list(
            lm_model.generate(
                conditions=[object()],
                early_stop_on_token=0,
                max_gen_len=2000,
                beam_size=1,
                forbidden_tokens=None,
            )
        )

    assert [step.tolist() for step in steps] == [[1], [0]]
    assert [step.tolist_calls for step in lm_model.steps] == [1, 1, 0]
    assert lm_model.generate_arguments[1]["early_stop_on_token"] is None


def test_backend_discards_chunk_when_guarded_retry_also_repeats(
    tmp_path,
) -> None:
    vocab = generation_vocab()

    class RepeatingLmModel:
        def __init__(self) -> None:
            self.calls = 0
            self.emb = SimpleNamespace(
                weight=SimpleNamespace(device="cpu"),
            )

        def generate(self, *args, **kwargs):
            self.calls += 1
            for token_id in [1, 2, 4, 5, *([6] * 8)]:
                yield FakeGenerationStep(token_id)

    class RepeatingTranscriptionModel:
        load_arguments = None

        def __init__(self) -> None:
            self._model = RepeatingLmModel()
            self._tokenizer = SimpleNamespace(_vocab=vocab)

        @classmethod
        def load_model(cls, path, device, dtype):
            cls.load_arguments = (path, device, dtype)
            return cls()

        def transcribe(
            self,
            audio_path,
            instruments,
            prelude_forcing,
            batch_size,
            beam_size,
        ):
            yield SimpleNamespace(completed=0, total=1)
            yield from ()
            list(
                self._model.generate(
                    conditions=[object()],
                    early_stop_on_token=0,
                    max_gen_len=2000,
                    beam_size=beam_size,
                    forbidden_tokens=[99],
                )
            )
            yield SimpleNamespace(completed=1, total=1)

    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")
    backend = CpuMuscriptorBackend(model_class=RepeatingTranscriptionModel)
    events = []

    backend.load(model_path, "float32")
    backend.transcribe(tmp_path / "audio.wav", ["violin"], events.append)

    assert backend._model._model.calls == 2
    assert BackendInvalidChunk(
        chunk_index=0,
        start_sec=0.0,
        end_sec=5.0,
        reason=(
            "chunk 0 (seek=0.0s) was discarded after guarded generation: "
            "the same onset, instrument, and pitch were generated 8 times; "
            "fallback: the same onset, instrument, and pitch were generated "
            "8 times"
        ),
    ) in events


def test_cpu_backend_maps_official_muscriptor_events(tmp_path) -> None:
    model_path = tmp_path / "model.safetensors"
    audio_path = tmp_path / "audio.wav"
    model_path.write_bytes(b"model")
    audio_path.write_bytes(b"audio")
    backend = CpuMuscriptorBackend(model_class=FakeModel)
    events = []

    backend.load(model_path, "float32")
    backend.transcribe(
        audio_path,
        ["violin"],
        events.append,
        beam_size=2,
        prelude_forcing=False,
        batch_size=3,
    )

    assert FakeModel.load_arguments == (model_path, "cpu", "float32")
    assert FakeModel.transcribe_arguments == (
        audio_path,
        ["violin"],
        False,
        3,
        2,
    )
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


def test_cpu_backend_allows_official_automatic_instrument_detection(
    tmp_path,
) -> None:
    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")
    backend = CpuMuscriptorBackend(model_class=FakeModel)

    backend.load(model_path, "float32")
    backend.transcribe(tmp_path / "audio.wav", None, lambda _event: None)

    assert FakeModel.transcribe_arguments == (
        tmp_path / "audio.wav",
        None,
        True,
        1,
        1,
    )


def test_cpu_backend_marks_chunks_that_reach_the_token_limit(tmp_path) -> None:
    class RunawayChunkModel(FakeModel):
        def transcribe(
            self,
            audio_path,
            instruments,
            prelude_forcing,
            batch_size,
            beam_size,
        ):
            yield SimpleNamespace(completed=0, total=4)
            yield SimpleNamespace(
                index=3,
                instrument="violin",
                pitch=72,
                start_time=15.25,
            )
            yield SimpleNamespace(start_event_index=3, end_time=15.75)
            warnings.warn(
                "chunk 3 (seek=15.0s) did not emit EOS within 2000 tokens",
                RuntimeWarning,
            )
            yield SimpleNamespace(completed=4, total=4)

    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")
    backend = CpuMuscriptorBackend(model_class=RunawayChunkModel)
    events = []

    backend.load(model_path, "float32")
    backend.transcribe(tmp_path / "audio.wav", ["violin"], events.append)

    assert BackendInvalidChunk(
        chunk_index=3,
        start_sec=15.0,
        end_sec=20.0,
        reason="chunk 3 (seek=15.0s) did not emit EOS within 2000 tokens",
    ) in events


def test_cpu_backend_refuses_non_local_model_reference() -> None:
    backend = CpuMuscriptorBackend(model_class=FakeModel)

    with pytest.raises(ValueError, match="見つかりません"):
        backend.load(Path("small"), "float32")


class FakeCuda:
    def __init__(self, available: bool) -> None:
        self._available = available
        self.cache_cleared = False
        self.cache_clear_count = 0

    def is_available(self) -> bool:
        return self._available

    def empty_cache(self) -> None:
        self.cache_cleared = True
        self.cache_clear_count += 1


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
    assert cuda.cache_clear_count == 1
    backend.transcribe(tmp_path / "audio.wav", ["violin"], lambda event: None)
    assert cuda.cache_clear_count == 2
    backend.unload()

    assert FakeModel.load_arguments == (model_path, "cuda", "float16")
    assert cuda.cache_cleared is True
    assert cuda.cache_clear_count == 3


def test_cuda_backend_releases_transcription_memory_after_handler_failure(
    tmp_path,
) -> None:
    class InterruptibleModel(FakeModel):
        closed = False

        def transcribe(
            self,
            audio_path,
            instruments,
            prelude_forcing,
            batch_size,
            beam_size,
        ):
            assert beam_size == 1
            try:
                yield SimpleNamespace(completed=0, total=1)
                yield SimpleNamespace(completed=1, total=1)
            finally:
                type(self).closed = True

    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")
    cuda = FakeCuda(available=True)
    backend = CudaMuscriptorBackend(
        model_class=InterruptibleModel,
        torch_module=SimpleNamespace(cuda=cuda),
    )
    backend.load(model_path, "float16")

    def fail_on_event(event) -> None:
        raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        backend.transcribe(tmp_path / "audio.wav", ["violin"], fail_on_event)

    assert InterruptibleModel.closed is True
    assert cuda.cache_clear_count == 2


def test_cuda_fp16_disables_redundant_model_autocast() -> None:
    autocast = SimpleNamespace(enabled=True)
    model = SimpleNamespace(_model=SimpleNamespace(autocast=autocast))

    configured = muscriptor_backend._configure_loaded_model(
        model,
        "cuda",
        "float16",
    )

    assert configured is model
    assert autocast.enabled is False


@pytest.mark.parametrize(
    ("device", "dtype"),
    [("cpu", "float32"), ("cuda", "float32")],
)
def test_non_fp16_model_keeps_autocast_setting(device, dtype) -> None:
    autocast = SimpleNamespace(enabled=True)
    model = SimpleNamespace(_model=SimpleNamespace(autocast=autocast))

    muscriptor_backend._configure_loaded_model(model, device, dtype)

    assert autocast.enabled is True


def test_cuda_fp16_load_keeps_weights_off_cuda_and_restores_torch_globals(
    tmp_path,
    monkeypatch,
) -> None:
    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")
    load_devices = []

    def load_file(path, device):
        load_devices.append((path, device))
        return {"weights": device}

    model_module = SimpleNamespace(load_file=load_file)

    class FakeTorch:
        float16 = "float16"

        def __init__(self) -> None:
            self.default_dtype = "float32"

        def get_default_dtype(self):
            return self.default_dtype

        def set_default_dtype(self, dtype) -> None:
            self.default_dtype = dtype

    torch = FakeTorch()

    class OfficialLikeModel:
        __module__ = "muscriptor.transcription_model"
        load_arguments = None
        loaded_state = None
        construction_dtype = None

        @classmethod
        def load_model(cls, path, device, dtype):
            cls.load_arguments = (path, device, dtype)
            cls.construction_dtype = torch.get_default_dtype()
            cls.loaded_state = model_module.load_file(path, device=device)
            return cls()

    monkeypatch.setattr(
        muscriptor_backend,
        "import_module",
        lambda name: model_module,
    )

    loaded = muscriptor_backend._load_model(
        OfficialLikeModel,
        model_path,
        "cuda",
        "float16",
        torch,
    )

    assert isinstance(loaded, OfficialLikeModel)
    assert OfficialLikeModel.load_arguments == (
        model_path,
        "cuda",
        "float16",
    )
    assert OfficialLikeModel.construction_dtype == "float16"
    assert OfficialLikeModel.loaded_state == {"weights": "cpu"}
    assert load_devices == [(model_path, "cpu")]
    assert torch.get_default_dtype() == "float32"
    assert model_module.load_file is load_file


def test_cuda_fp16_load_restores_torch_globals_after_failure(
    tmp_path,
    monkeypatch,
) -> None:
    model_path = tmp_path / "model.safetensors"
    model_path.write_bytes(b"model")

    def load_file(path, device):
        return (path, device)

    model_module = SimpleNamespace(load_file=load_file)

    class FakeTorch:
        float16 = "float16"

        def __init__(self) -> None:
            self.default_dtype = "float32"

        def get_default_dtype(self):
            return self.default_dtype

        def set_default_dtype(self, dtype) -> None:
            self.default_dtype = dtype

    torch = FakeTorch()

    class FailingModel:
        __module__ = "muscriptor.transcription_model"

        @classmethod
        def load_model(cls, path, device, dtype):
            raise RuntimeError("load failed")

    monkeypatch.setattr(
        muscriptor_backend,
        "import_module",
        lambda name: model_module,
    )

    with pytest.raises(RuntimeError, match="load failed"):
        muscriptor_backend._load_model(
            FailingModel,
            model_path,
            "cuda",
            "float16",
            torch,
        )

    assert torch.get_default_dtype() == "float32"
    assert model_module.load_file is load_file


def test_cuda_backend_reports_missing_gpu() -> None:
    backend = CudaMuscriptorBackend(
        model_class=FakeModel,
        torch_module=SimpleNamespace(cuda=FakeCuda(available=False)),
    )

    capability = backend.capabilities()

    assert capability.available is False
    assert capability.unavailable_reason == "対応するNVIDIA GPUが見つかりません"
