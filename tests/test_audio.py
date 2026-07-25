import math
import shutil
import struct
import wave

import pytest

from earcopy_service.audio import inspect_audio, prepare_analysis_audio


def _write_wave(path, sample_rate: int = 8000, duration: float = 0.25) -> None:
    samples = [
        int(10000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        for index in range(int(sample_rate * duration))
    ]
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))


@pytest.mark.parametrize("sample_rate", [8000, 44100, 48000, 96000])
def test_inspect_audio_reads_wave_metadata_and_hash(
    tmp_path, sample_rate: int
) -> None:
    path = tmp_path / "tone.wav"
    _write_wave(path, sample_rate=sample_rate)

    info = inspect_audio(path, ffprobe_executable="missing-ffprobe-for-test")

    assert info.sample_rate == sample_rate
    assert info.channels == 1
    assert info.duration_sec == 0.25
    assert len(info.sha256) == 64
    assert info.absolute_path == str(path.resolve())


def test_inspect_audio_rejects_unsupported_extension(tmp_path) -> None:
    path = tmp_path / "notes.txt"
    path.write_text("not audio", encoding="utf-8")

    try:
        inspect_audio(path)
    except ValueError as exc:
        assert "未対応" in str(exc)
    else:
        raise AssertionError("unsupported extension must fail")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpegが必要です")
def test_prepare_analysis_audio_converts_and_reuses_cache(tmp_path) -> None:
    source = tmp_path / "source.wav"
    _write_wave(source)
    cache = tmp_path / "cache"

    first = prepare_analysis_audio(source, cache)
    second = prepare_analysis_audio(source, cache)
    info = inspect_audio(first)

    assert first == second
    assert first.name == "analysis.wav"
    assert info.sample_rate == 44_100
    assert info.channels == 2
    assert first.is_file()
