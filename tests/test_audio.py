import hashlib
import math
import os
import shutil
import struct
import wave

import pytest

from earcopy_service.audio import (
    inspect_audio,
    playback_audio_info,
    prepare_analysis_audio,
    read_playback_audio_frames,
)


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


def test_read_playback_audio_frames_preserves_source_and_frame_order(tmp_path) -> None:
    import numpy
    import soundfile

    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    first_samples = numpy.array(
        [[0.0, 0.1], [0.2, 0.3], [0.4, 0.5]],
        dtype=numpy.float32,
    )
    second_samples = numpy.array(
        [[1.0, 0.9], [0.8, 0.7], [0.6, 0.5]],
        dtype=numpy.float32,
    )
    soundfile.write(first, first_samples, 44_100, subtype="FLOAT")
    soundfile.write(second, second_samples, 44_100, subtype="FLOAT")

    information = playback_audio_info(first)
    payload = read_playback_audio_frames([first, second], 1, 4)
    decoded = numpy.frombuffer(payload, dtype="<f4").reshape(2, 4, 2)

    assert information.sample_rate == 44_100
    assert information.channels == 2
    assert information.frame_count == 3
    numpy.testing.assert_allclose(decoded[0, :2], first_samples[1:])
    numpy.testing.assert_allclose(decoded[1, :2], second_samples[1:])
    numpy.testing.assert_array_equal(decoded[:, 2:], 0)


def test_reusing_analysis_audio_keeps_it_in_the_latest_ten(tmp_path) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"cached source")
    cache = tmp_path / "audio"
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    cache_key = hashlib.sha256(
        f"{source_hash}:44100:2:pcm_f32le".encode("ascii")
    ).hexdigest()
    current = cache / cache_key
    current.mkdir(parents=True)
    (current / "analysis.wav").write_bytes(b"x" * 45)
    os.utime(current / "analysis.wav", (1_000_000, 1_000_000))
    for index in range(10):
        entry = cache / f"newer-{index:02d}"
        entry.mkdir()
        analysis = entry / "analysis.wav"
        analysis.write_bytes(b"x" * 45)
        os.utime(analysis, (1_000_100 + index, 1_000_100 + index))

    reused = prepare_analysis_audio(source, cache)

    assert reused == current / "analysis.wav"
    assert current.exists()
    assert len(list(cache.iterdir())) == 10
