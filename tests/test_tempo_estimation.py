import sys
from pathlib import Path
from types import SimpleNamespace

import librosa
import numpy as np
import pytest

import earcopy_service.tempo_estimation as tempo_estimation
from earcopy_service.tempo_estimation import _estimate_fixed_tempo, estimate_tempo


class _FakeAudio:
    size = 100


def test_estimate_tempo_uses_mono_22050hz_and_rounds_result(
    tmp_path, monkeypatch
) -> None:
    calls = {}

    def load(path, sr, mono):
        calls["load"] = (path, sr, mono)
        return _FakeAudio(), sr

    def onset_strength(y, sr, hop_length, aggregate):
        calls["onset"] = (y, sr, hop_length, aggregate)
        return [0.1, 0.8, 0.2]

    fake_librosa = SimpleNamespace(
        load=load,
        onset=SimpleNamespace(onset_strength=onset_strength),
        frames_to_time=lambda frames, sr, hop_length: [
            0.2,
            0.2 + 60 / 123.456,
        ],
    )
    monkeypatch.setattr(
        tempo_estimation,
        "_estimate_fixed_tempo",
        lambda *_args: (123.456, [1, 2]),
    )
    monkeypatch.setitem(sys.modules, "librosa", fake_librosa)
    path = tmp_path / "audio.wav"

    estimate = estimate_tempo(path)

    assert estimate.bpm == 123.5
    assert estimate.sample_rate == 22050
    assert estimate.beat_offset_sec == 0.2
    assert calls["load"] == (path, 22050, True)
    assert calls["onset"][0].size == 100
    assert calls["onset"][1:3] == (22050, 512)


def _steady_onset_envelope(bpm: float, duration_sec: float = 30.0) -> np.ndarray:
    frame_rate = 22050 / 512
    envelope = np.zeros(round(frame_rate * duration_sec))
    period_frames = frame_rate * 60 / bpm
    for beat_index in range(round(duration_sec * bpm / 60)):
        frame = round(8 + beat_index * period_frames)
        if frame < envelope.size:
            envelope[frame] = 1.0 if beat_index % 4 == 0 else 0.7
    return np.convolve(envelope, np.array([0.2, 1.0, 0.3]), mode="same")


def _half_time_accented_onset_envelope(
    bpm: float,
    duration_sec: float = 30.0,
) -> np.ndarray:
    frame_rate = 22050 / 512
    envelope = np.zeros(round(frame_rate * duration_sec))
    period_frames = frame_rate * 60 / bpm
    for beat_index in range(round(duration_sec * bpm / 60)):
        frame = round(8 + beat_index * period_frames)
        if frame < envelope.size:
            envelope[frame] = 1.0 if beat_index % 2 == 0 else 0.3
    return np.convolve(envelope, np.array([0.2, 1.0, 0.3]), mode="same")


def test_fixed_tempo_comparison_corrects_half_tempo_estimate() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _steady_onset_envelope(180),
        22050,
    )

    assert bpm == pytest.approx(180, abs=0.2)
    assert len(beats) >= 85


def test_fixed_tempo_comparison_does_not_double_slow_tempo() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _steady_onset_envelope(60),
        22050,
    )

    assert bpm == pytest.approx(60, abs=0.2)
    assert 25 <= len(beats) <= 32


def test_fixed_tempo_uses_supported_weak_beats_instead_of_half_tempo() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _half_time_accented_onset_envelope(172),
        22050,
    )

    assert bpm == pytest.approx(172, abs=0.2)
    assert len(beats) >= 80


@pytest.mark.parametrize(
    ("filename", "expected_bpm"),
    [
        ("bpm172.wav", 172.0),
        ("bpm173.wav", 173.0),
    ],
)
def test_real_tempo_fixture_detects_full_tempo(
    filename: str,
    expected_bpm: float,
) -> None:
    path = Path(__file__).with_name(filename)
    if not path.exists():
        pytest.skip(f"Local tempo fixture is not available: {filename}")

    estimate = estimate_tempo(path)

    assert estimate.bpm == pytest.approx(expected_bpm, abs=0.6)
