from __future__ import annotations

import hashlib
import wave
import weakref
from dataclasses import replace

import httpx
import pytest

import earcopy_service.stem_separation as stem_separation
from earcopy_service.models import Stem
from earcopy_service.stem_separation import (
    BS_ROFORMER_SW_MODEL_FILE,
    BS_ROFORMER_SW_PROFILE,
    STEM_NAMES,
    StemInferenceSettings,
    StemSeparationCancelled,
    _apply_stem_model,
    _cuda_memory_log_fields,
    _separated_stems_by_name,
    mix_bass_with_highpassed_drums_for_transcription,
    mix_stems_for_transcription,
    configured_stem_model_directory,
    _read_cached_stems,
    _separate_with_device,
    _separate_with_fallback,
    export_stems,
    stem_model_status,
    validate_stem_model,
)


def _write_wav(path) -> str:
    with wave.open(str(path), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(3)
        target.setframerate(44_100)
        target.writeframes(b"\0" * 3 * 2 * 20)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_download_stem_model_verifies_size_and_sha256(
    tmp_path,
    monkeypatch,
) -> None:
    content = b"verified-checkpoint"
    model_directory = tmp_path / "models" / "bs-roformer" / "sw-fixed"
    profile = replace(
        stem_separation.BS_ROFORMER_SW_PROFILE,
        model_sha256=hashlib.sha256(content).hexdigest(),
    )
    distribution = replace(
        stem_separation.BS_ROFORMER_SW_DISTRIBUTION,
        download_url="https://models.example.test/checkpoint",
        model_size_bytes=len(content),
    )
    monkeypatch.setattr(stem_separation, "BS_ROFORMER_SW_PROFILE", profile)
    monkeypatch.setattr(
        stem_separation,
        "BS_ROFORMER_SW_DISTRIBUTION",
        distribution,
    )
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_directory))

    def respond(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == distribution.download_url
        return httpx.Response(
            200,
            content=content,
            headers={"Content-Length": str(len(content))},
        )

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        status = stem_separation.download_stem_model(client)

    model_path = model_directory / BS_ROFORMER_SW_MODEL_FILE
    assert model_path.read_bytes() == content
    assert not model_path.with_name(f"{model_path.name}.download").exists()
    assert status["available"] is True
    assert status["licenseStatus"] == "Unknown"
    assert status["modelSha256"] == profile.model_sha256


def test_download_stem_model_preserves_existing_file_after_hash_failure(
    tmp_path,
    monkeypatch,
) -> None:
    expected = b"correct"
    received = b"corrupt"
    model_directory = tmp_path / "sw-fixed"
    model_directory.mkdir()
    model_path = model_directory / BS_ROFORMER_SW_MODEL_FILE
    model_path.write_bytes(b"existing")
    profile = replace(
        stem_separation.BS_ROFORMER_SW_PROFILE,
        model_sha256=hashlib.sha256(expected).hexdigest(),
    )
    distribution = replace(
        stem_separation.BS_ROFORMER_SW_DISTRIBUTION,
        download_url="https://models.example.test/checkpoint",
        model_size_bytes=len(received),
    )
    monkeypatch.setattr(stem_separation, "BS_ROFORMER_SW_PROFILE", profile)
    monkeypatch.setattr(
        stem_separation,
        "BS_ROFORMER_SW_DISTRIBUTION",
        distribution,
    )
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_directory))

    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=received)
    )
    with httpx.Client(transport=transport) as client:
        with pytest.raises(ValueError, match="SHA-256"):
            stem_separation.download_stem_model(client)

    assert model_path.read_bytes() == b"existing"
    assert not model_path.with_name(f"{model_path.name}.download").exists()


def test_export_stems_uses_required_names_and_preserves_bytes(tmp_path) -> None:
    cache = tmp_path / "cache"
    cache.mkdir()
    stems = []
    for name in STEM_NAMES:
        source = cache / f"{name}.wav"
        digest = _write_wav(source)
        stems.append(Stem(type=name, cachePath=str(source), sha256=digest))

    outputs = export_stems(stems, tmp_path / "output", 'bad:/name')

    assert [item.name for item in outputs] == [
        "bad__name_drums.wav",
        "bad__name_bass.wav",
        "bad__name_vocals.wav",
        "bad__name_other.wav",
        "bad__name_piano.wav",
        "bad__name_guitar.wav",
    ]
    for output, stem_name in zip(outputs, STEM_NAMES, strict=True):
        assert output.read_bytes() == (cache / f"{stem_name}.wav").read_bytes()


def test_export_stems_rejects_missing_or_modified_cache(tmp_path) -> None:
    source = tmp_path / "drums.wav"
    digest = _write_wav(source)
    stems = [Stem(type="drums", cachePath=str(source), sha256=digest)]

    with pytest.raises(ValueError, match="出力できない"):
        export_stems(stems, tmp_path / "output", "song")


def test_mix_stems_for_transcription_preserves_alignment_and_sum(
    tmp_path,
) -> None:
    import numpy
    import soundfile

    sources = []
    expected = numpy.zeros((100_000, 2), dtype=numpy.float32)
    for index, value in enumerate((0.1, -0.025, 0.2)):
        source = tmp_path / f"stem-{index}.wav"
        audio = numpy.full((100_000, 2), value, dtype=numpy.float32)
        soundfile.write(source, audio, 48_000, subtype="FLOAT")
        sources.append(source)
        expected += audio

    output = mix_stems_for_transcription(
        sources,
        tmp_path / "mixed.wav",
    )
    mixed, sample_rate = soundfile.read(
        output,
        dtype="float32",
        always_2d=True,
    )

    assert sample_rate == 48_000
    assert soundfile.info(output).subtype == "FLOAT"
    assert mixed.shape == expected.shape
    assert numpy.allclose(mixed, expected)


def test_mix_stems_for_transcription_applies_per_source_gains(tmp_path) -> None:
    import numpy
    import soundfile

    source = tmp_path / "source.wav"
    guide = tmp_path / "guide.wav"
    soundfile.write(
        source,
        numpy.full((100, 2), 0.25, dtype=numpy.float32),
        44_100,
        subtype="FLOAT",
    )
    soundfile.write(
        guide,
        numpy.full((100, 2), 0.5, dtype=numpy.float32),
        44_100,
        subtype="FLOAT",
    )

    output = mix_stems_for_transcription(
        [source, guide],
        tmp_path / "guided.wav",
        gains=[1.0, 0.1],
    )
    mixed, _sample_rate = soundfile.read(output, dtype="float32")

    assert numpy.allclose(mixed, 0.3)


def test_bass_timing_guide_attenuates_c_sharp_3_and_keeps_attack_band(
    tmp_path,
) -> None:
    import numpy
    import soundfile

    sample_rate = 48_000
    duration_sec = 2.0
    sample_count = round(sample_rate * duration_sec)
    times = numpy.arange(sample_count, dtype=numpy.float64) / sample_rate
    c_sharp_3_hz = 138.59
    attack_hz = 2_000.0
    drums_mono = 0.2 * (
        numpy.sin(2 * numpy.pi * c_sharp_3_hz * times)
        + numpy.sin(2 * numpy.pi * attack_hz * times)
    )
    drums = numpy.column_stack((drums_mono, drums_mono)).astype(numpy.float32)
    bass = numpy.zeros_like(drums)
    bass_path = tmp_path / "bass.wav"
    drums_path = tmp_path / "drums.wav"
    soundfile.write(bass_path, bass, sample_rate, subtype="FLOAT")
    soundfile.write(drums_path, drums, sample_rate, subtype="FLOAT")

    output = mix_bass_with_highpassed_drums_for_transcription(
        bass_path,
        drums_path,
        0.3,
        tmp_path / "bass-with-highpassed-drums-g30.wav",
    )
    mixed, output_sample_rate = soundfile.read(
        output,
        dtype="float32",
        always_2d=True,
    )
    analysis = mixed[round(0.25 * sample_rate) :, 0]
    analysis_times = times[-len(analysis) :]

    def amplitude(frequency_hz: float) -> float:
        basis = numpy.exp(-2j * numpy.pi * frequency_hz * analysis_times)
        return float(2 * numpy.abs(numpy.sum(analysis * basis)) / len(analysis))

    low_amplitude = amplitude(c_sharp_3_hz)
    attack_amplitude = amplitude(attack_hz)

    assert output_sample_rate == sample_rate
    assert soundfile.info(output).subtype == "FLOAT"
    assert attack_amplitude == pytest.approx(0.06, rel=0.1)
    assert attack_amplitude > low_amplitude * 8


def test_bass_timing_guide_accepts_an_evaluation_cutoff(tmp_path) -> None:
    import numpy
    import soundfile

    sample_rate = 48_000
    times = numpy.arange(sample_rate, dtype=numpy.float64) / sample_rate
    drums_mono = numpy.sin(2 * numpy.pi * 180.0 * times).astype(numpy.float32)
    drums = numpy.column_stack((drums_mono, drums_mono))
    bass = numpy.zeros_like(drums)
    bass_path = tmp_path / "bass.wav"
    drums_path = tmp_path / "drums.wav"
    soundfile.write(bass_path, bass, sample_rate, subtype="FLOAT")
    soundfile.write(drums_path, drums, sample_rate, subtype="FLOAT")

    low_cutoff = mix_bass_with_highpassed_drums_for_transcription(
        bass_path,
        drums_path,
        0.1,
        tmp_path / "low-cutoff.wav",
        cutoff_hz=125.0,
    )
    high_cutoff = mix_bass_with_highpassed_drums_for_transcription(
        bass_path,
        drums_path,
        0.1,
        tmp_path / "high-cutoff.wav",
        cutoff_hz=500.0,
    )
    low_audio, _ = soundfile.read(low_cutoff, dtype="float32")
    high_audio, _ = soundfile.read(high_cutoff, dtype="float32")

    analysis_start = sample_rate // 4
    assert numpy.sqrt(numpy.mean(low_audio[analysis_start:] ** 2)) > (
        numpy.sqrt(numpy.mean(high_audio[analysis_start:] ** 2)) * 20
    )


def test_mix_stems_for_transcription_rejects_invalid_gains(tmp_path) -> None:
    source = tmp_path / "source.wav"
    _write_wav(source)

    with pytest.raises(ValueError, match="ゲイン"):
        mix_stems_for_transcription(
            [source],
            tmp_path / "mixed.wav",
            gains=[1.0, 0.1],
        )


def test_mix_stems_for_transcription_rejects_misaligned_sources(
    tmp_path,
) -> None:
    import numpy
    import soundfile

    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    soundfile.write(first, numpy.zeros((100, 2)), 44_100)
    soundfile.write(second, numpy.zeros((99, 2)), 44_100)

    with pytest.raises(ValueError, match="一致しません"):
        mix_stems_for_transcription(
            [first, second],
            tmp_path / "mixed.wav",
        )


def test_mix_stems_for_transcription_removes_partial_output_on_cancel(
    tmp_path,
) -> None:
    import numpy
    import soundfile

    sources = []
    for index in range(2):
        source = tmp_path / f"stem-{index}.wav"
        soundfile.write(
            source,
            numpy.zeros((100_000, 2), dtype=numpy.float32),
            44_100,
            subtype="FLOAT",
        )
        sources.append(source)

    checks = 0

    def cancel_after_first_block() -> bool:
        nonlocal checks
        checks += 1
        return checks >= 3

    output = tmp_path / "mixed.wav"
    with pytest.raises(StemSeparationCancelled):
        mix_stems_for_transcription(
            sources,
            output,
            cancel_check=cancel_after_first_block,
        )

    assert not output.exists()
    assert list(tmp_path.glob(".mixed.wav.*.tmp")) == []


def test_stem_model_validation_rejects_missing_model(tmp_path) -> None:
    with pytest.raises(FileNotFoundError, match=BS_ROFORMER_SW_MODEL_FILE):
        validate_stem_model(tmp_path)


def test_stem_model_directory_uses_explicit_external_path(
    monkeypatch, tmp_path
) -> None:
    model_root = tmp_path / "models"
    model_directory = model_root / "bs-roformer" / "sw-fixed"
    model_directory.mkdir(parents=True)
    (model_directory / BS_ROFORMER_SW_MODEL_FILE).touch()
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_root))

    assert configured_stem_model_directory() == model_directory.resolve()


def test_missing_stem_model_reports_external_directory(
    monkeypatch, tmp_path
) -> None:
    model_directory = tmp_path / "models" / "bs-roformer" / "sw-fixed"
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_directory))

    with pytest.raises(FileNotFoundError, match="配置先") as error:
        configured_stem_model_directory()

    assert str(model_directory.resolve()) in str(error.value)


def test_stem_model_status_reports_external_availability(
    monkeypatch, tmp_path
) -> None:
    model_directory = tmp_path / "models" / "bs-roformer" / "sw-fixed"
    monkeypatch.setenv("EARCOPY_STEM_MODEL_DIR", str(model_directory))

    missing = stem_model_status()
    model_directory.mkdir(parents=True)
    (model_directory / BS_ROFORMER_SW_MODEL_FILE).touch()
    available = stem_model_status()

    assert missing["available"] is False
    assert missing["modelDirectory"] == str(model_directory.resolve())
    assert available["available"] is True
    assert available["modelDirectory"] == str(model_directory.resolve())
    assert available["modelName"] == "BS-RoFormer SW Fixed"
    assert available["reason"] == ""


def test_stem_model_validation_rejects_wrong_hash(tmp_path) -> None:
    (tmp_path / BS_ROFORMER_SW_MODEL_FILE).write_bytes(b"not-a-checkpoint")

    with pytest.raises(ValueError, match="モデルのSHA-256"):
        validate_stem_model(tmp_path)


def test_stem_chunked_overlap_preserves_model_output() -> None:
    import torch

    class RepeatModel:
        def __call__(self, chunk):
            return chunk[:, None].repeat(1, 6, 1, 1)

    waveform = torch.linspace(-0.5, 0.5, 40).repeat(2, 1)
    separated = _apply_stem_model(
        RepeatModel(),
        waveform,
        9,
        num_overlap=4,
        batch_size=3,
    )

    assert separated.shape == (6, 2, 40)
    assert torch.allclose(separated[0], waveform)


def test_stem_chunking_reports_completed_inference_chunks() -> None:
    import torch

    class RepeatModel:
        def __call__(self, chunk):
            return chunk[:, None].repeat(1, 6, 1, 1)

    observations: list[tuple[int, int]] = []
    _apply_stem_model(
        RepeatModel(),
        torch.linspace(-0.5, 0.5, 40).repeat(2, 1),
        9,
        num_overlap=4,
        batch_size=3,
        progress_callback=lambda completed, total: observations.append(
            (completed, total)
        ),
    )

    assert observations[0] == (0, 27)
    assert observations[-1] == (27, 27)
    assert [completed for completed, _ in observations] == [
        0,
        3,
        6,
        9,
        12,
        15,
        18,
        21,
        24,
        27,
    ]


def test_separated_stems_preserve_model_outputs() -> None:
    import torch

    source_order = BS_ROFORMER_SW_PROFILE.source_order
    separated = torch.zeros(len(source_order), 2, 2)
    separated[source_order.index("bass")] = 0.1
    separated[source_order.index("drums")] = 0.2
    separated[source_order.index("other")] = 0.05
    separated[source_order.index("vocals")] = 0.15
    separated[source_order.index("guitar")] = 0.03
    separated[source_order.index("piano")] = 0.02

    components = _separated_stems_by_name(
        separated,
        source_order,
    )

    assert tuple(components) == STEM_NAMES
    assert torch.allclose(components["piano"], torch.full((2, 2), 0.02))
    assert torch.allclose(components["guitar"], torch.full((2, 2), 0.03))
    assert torch.allclose(components["other"], torch.full((2, 2), 0.05))


def test_stem_chunking_honors_cancellation_between_chunks() -> None:
    import torch

    calls = 0

    class CountingModel:
        def __call__(self, chunk):
            nonlocal calls
            calls += 1
            return chunk[:, None].repeat(1, 4, 1, 1)

    waveform = torch.arange(80, dtype=torch.float32).reshape(2, 40)

    with pytest.raises(StemSeparationCancelled):
        _apply_stem_model(
            CountingModel(),
            waveform,
            9,
            cancel_check=lambda: calls >= 1,
        )

    assert calls == 1


def test_cuda_memory_diagnostics_resolve_an_unspecified_device_index() -> None:
    class FakeCuda:
        current_device_calls = 0

        @classmethod
        def current_device(cls):
            cls.current_device_calls += 1
            return 2

        @staticmethod
        def mem_get_info(device):
            assert device == 2
            return 3_000, 6_000

        @staticmethod
        def memory_allocated(device):
            assert device == 2
            return 1_000

        @staticmethod
        def memory_reserved(device):
            assert device == 2
            return 2_000

    class FakeTorch:
        cuda = FakeCuda

    class Device:
        index = None

    assert _cuda_memory_log_fields(FakeTorch, Device()) == (
        " cuda_allocated=1000 cuda_reserved=2000"
        " cuda_free=3000 cuda_total=6000"
    )
    assert FakeCuda.current_device_calls == 1


def test_stem_cuda_oom_retries_on_cpu(monkeypatch, tmp_path) -> None:
    import torch

    devices = []

    def separate(
        repository,
        normalized,
        device,
        cancel_check=None,
        progress_callback=None,
    ):
        devices.append(device.type)
        if device.type == "cuda":
            raise torch.cuda.OutOfMemoryError
        return normalized

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: None)
    monkeypatch.setattr(stem_separation, "_separate_with_device", separate)

    normalized = torch.zeros(2, 20)
    separated = _separate_with_fallback(torch, tmp_path, normalized)

    assert devices == ["cuda", "cpu"]
    assert separated is normalized


@pytest.mark.parametrize("fail_inference", [False, True])
def test_stem_cuda_model_is_released_immediately_after_inference(
    monkeypatch,
    tmp_path,
    fail_inference,
) -> None:
    import torch

    class Model:
        pass

    model_references = []
    release_observations = []

    def load_model(repository, device):
        model = Model()
        model_references.append(weakref.ref(model))
        return model, StemInferenceSettings(
            profile=BS_ROFORMER_SW_PROFILE,
            segment_samples=10,
            num_overlap=2,
            batch_size=1,
            normalize=False,
            use_amp=False,
        )

    def apply_model(
        model,
        waveform,
        segment_samples,
        num_overlap,
        batch_size,
        use_amp,
        device,
        cancel_check=None,
        progress_callback=None,
    ):
        if fail_inference:
            raise RuntimeError("inference failed")
        return waveform

    def release_memory(torch_module):
        release_observations.append(model_references[0]() is None)

    monkeypatch.setattr(stem_separation, "_load_stem_model", load_model)
    monkeypatch.setattr(stem_separation, "_apply_stem_model", apply_model)
    monkeypatch.setattr(stem_separation, "_release_cuda_memory", release_memory)

    normalized = torch.zeros(2, 20)
    if fail_inference:
        with pytest.raises(RuntimeError, match="inference failed"):
            _separate_with_device(
                tmp_path,
                normalized,
                torch.device("cuda"),
            )
    else:
        assert (
            _separate_with_device(
                tmp_path,
                normalized,
                torch.device("cuda"),
            )
            is normalized
        )

    assert release_observations == [True]


def test_stem_cuda_oom_retries_with_a_smaller_batch(
    monkeypatch,
    tmp_path,
) -> None:
    import torch

    batch_sizes = []
    releases = 0

    def load_model(repository, device):
        return object(), StemInferenceSettings(
            profile=BS_ROFORMER_SW_PROFILE,
            segment_samples=10,
            num_overlap=4,
            batch_size=4,
            normalize=False,
            use_amp=True,
        )

    def apply_model(
        model,
        waveform,
        segment_samples,
        num_overlap,
        batch_size,
        use_amp,
        device,
        cancel_check=None,
        progress_callback=None,
    ):
        batch_sizes.append(batch_size)
        if batch_size == 4:
            raise torch.cuda.OutOfMemoryError
        return waveform

    def release_memory(torch_module):
        nonlocal releases
        releases += 1

    monkeypatch.setattr(stem_separation, "_load_stem_model", load_model)
    monkeypatch.setattr(stem_separation, "_apply_stem_model", apply_model)
    monkeypatch.setattr(stem_separation, "_release_cuda_memory", release_memory)

    waveform = torch.ones(2, 20)
    separated = _separate_with_device(
        tmp_path,
        waveform,
        torch.device("cuda"),
    )

    assert separated is waveform
    assert batch_sizes == [4, 2]
    assert releases == 2


def test_complete_24_bit_stem_cache_is_reused(tmp_path) -> None:
    for name in STEM_NAMES:
        _write_wav(tmp_path / f"{name}.wav")

    stems = _read_cached_stems(tmp_path)

    assert stems is not None
    assert [stem.type for stem in stems] == list(STEM_NAMES)
