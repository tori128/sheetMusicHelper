from __future__ import annotations

import hashlib
import wave

import pytest

import earcopy_service.stem_separation as stem_separation
from earcopy_service.models import Stem
from earcopy_service.stem_separation import (
    SCNET_CONFIG_FILE,
    SCNET_MODEL_FILE,
    _apply_scnet_model,
    _read_cached_stems,
    _separate_with_fallback,
    export_stems,
    validate_scnet_model,
)


def _write_wav(path) -> str:
    with wave.open(str(path), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(3)
        target.setframerate(44_100)
        target.writeframes(b"\0" * 3 * 2 * 20)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_export_stems_uses_required_names_and_preserves_bytes(tmp_path) -> None:
    cache = tmp_path / "cache"
    cache.mkdir()
    stems = []
    for name in ("drums", "bass", "vocals", "other"):
        source = cache / f"{name}.wav"
        digest = _write_wav(source)
        stems.append(Stem(type=name, cachePath=str(source), sha256=digest))

    outputs = export_stems(stems, tmp_path / "output", 'bad:/name')

    assert [item.name for item in outputs] == [
        "bad__name_drums.wav",
        "bad__name_bass.wav",
        "bad__name_vocals.wav",
        "bad__name_other.wav",
    ]
    assert outputs[0].read_bytes() == (cache / "drums.wav").read_bytes()


def test_export_stems_rejects_missing_or_modified_cache(tmp_path) -> None:
    source = tmp_path / "drums.wav"
    digest = _write_wav(source)
    stems = [Stem(type="drums", cachePath=str(source), sha256=digest)]

    with pytest.raises(ValueError, match="出力できない"):
        export_stems(stems, tmp_path / "output", "song")


def test_scnet_model_validation_rejects_missing_model(tmp_path) -> None:
    with pytest.raises(FileNotFoundError, match=SCNET_MODEL_FILE):
        validate_scnet_model(tmp_path)


def test_scnet_model_validation_rejects_wrong_hash(tmp_path) -> None:
    (tmp_path / SCNET_MODEL_FILE).write_bytes(b"not-a-checkpoint")
    (tmp_path / SCNET_CONFIG_FILE).write_text("model: {}", encoding="utf-8")

    with pytest.raises(ValueError, match="モデルのSHA-256"):
        validate_scnet_model(tmp_path)


def test_scnet_chunked_overlap_preserves_model_output() -> None:
    import torch

    class RepeatModel:
        def __call__(self, chunk):
            return chunk[:, None].repeat(1, 4, 1, 1)

    waveform = torch.linspace(-0.5, 0.5, 40).repeat(2, 1)
    separated = _apply_scnet_model(RepeatModel(), waveform, 0.0002)

    assert separated.shape == (4, 2, 40)
    assert torch.allclose(separated[0], waveform)


def test_scnet_cuda_oom_retries_on_cpu(monkeypatch, tmp_path) -> None:
    import torch

    devices = []

    def separate(repository, normalized, device):
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


def test_complete_24_bit_stem_cache_is_reused(tmp_path) -> None:
    for name in ("drums", "bass", "vocals", "other"):
        _write_wav(tmp_path / f"{name}.wav")

    stems = _read_cached_stems(tmp_path)

    assert stems is not None
    assert [stem.type for stem in stems] == [
        "drums",
        "bass",
        "vocals",
        "other",
    ]
