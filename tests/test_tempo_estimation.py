import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import librosa
import numpy as np
import pytest

import earcopy_service.tempo_estimation as tempo_estimation
from earcopy_service.audio import prepare_analysis_audio
from earcopy_service.tempo_estimation import (
    HOP_LENGTH,
    _estimate_fixed_tempo,
    _estimate_measure_offset,
    _fit_beat_grid_phase,
    _refine_fixed_bpm,
    _select_measure_offset,
    estimate_tempo,
)


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
            1.2,
            1.2 + 60 / 123.456,
        ],
    )
    monkeypatch.setattr(
        tempo_estimation,
        "_estimate_fixed_tempo",
        lambda *_args: (123.456, [1, 2]),
    )
    monkeypatch.setattr(
        tempo_estimation,
        "_estimate_measure_offset",
        lambda *_args: 0.37,
    )
    monkeypatch.setitem(sys.modules, "librosa", fake_librosa)
    path = tmp_path / "audio.wav"

    estimate = estimate_tempo(path, numerator=3, denominator=4)

    assert estimate.bpm == 123.5
    assert estimate.sample_rate == 22050
    assert estimate.beat_offset_sec == 0.37
    assert calls["load"] == (path, 22050, True)
    assert calls["onset"][0].size == 100
    assert calls["onset"][1:3] == (22050, 512)


def test_beat_grid_phase_uses_all_detected_beats() -> None:
    beat_times = np.asarray([2.12, 2.61, 3.13, 3.62, 4.11, 4.63])

    phase = _fit_beat_grid_phase(np, beat_times, 0.5)

    assert phase == pytest.approx(0.12, abs=0.01)


def test_measure_offset_selects_recurring_low_frequency_energy() -> None:
    low_frequency_energy = np.full(24, 0.1)
    low_frequency_energy[2::4] = 1.0

    offset = _select_measure_offset(
        np,
        grid_phase_sec=0.1,
        grid_period_sec=0.5,
        slots_per_measure=4,
        first_beat_grid_index=0,
        low_frequency_energy_strengths=low_frequency_energy,
    )

    assert offset == pytest.approx(1.1)


def test_measure_offset_uses_first_detected_beat_when_features_are_equal() -> None:
    equal = np.ones(16)

    offset = _select_measure_offset(
        np,
        grid_phase_sec=0.2,
        grid_period_sec=0.5,
        slots_per_measure=4,
        first_beat_grid_index=3,
        low_frequency_energy_strengths=equal,
    )

    assert offset == pytest.approx(1.7)


def test_measure_offset_uses_energy_below_150_hz() -> None:
    sample_rate = 22050
    duration_sec = 8.0
    audio = np.zeros(round(duration_sec * sample_rate))
    burst_samples = round(0.08 * sample_rate)
    burst_time = np.arange(burst_samples) / sample_rate
    burst = np.sin(2 * np.pi * 80 * burst_time) * np.hanning(burst_samples)
    for time_sec in (1.0, 3.0, 5.0, 7.0):
        start = round(time_sec * sample_rate)
        audio[start : start + burst_samples] += burst

    offset = _estimate_measure_offset(
        librosa,
        np,
        audio,
        sample_rate,
        np.arange(0.0, duration_sec, 0.5),
        120.0,
        4,
        4,
    )

    assert offset == pytest.approx(1.0)


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


def _steady_beat_frames(
    bpm: float,
    count: int = 240,
    offset_frames: float = 5,
) -> np.ndarray:
    frame_rate = 22050 / HOP_LENGTH
    period_frames = frame_rate * 60 / bpm
    return np.asarray(
        [
            round(offset_frames + beat_index * period_frames)
            for beat_index in range(count)
        ],
        dtype=int,
    )


def test_fixed_tempo_refinement_preserves_non_integer_tempo() -> None:
    refined = _refine_fixed_bpm(
        librosa,
        np,
        _steady_beat_frames(123.4),
        22050,
        123.4,
    )

    assert refined == pytest.approx(123.4, abs=0.1)


@pytest.mark.parametrize("outlier_start", [96, 216])
def test_fixed_tempo_refinement_rejects_local_phase_drift(
    outlier_start: int,
) -> None:
    beat_frames = _steady_beat_frames(150)
    beat_frames[outlier_start : outlier_start + 24] += np.rint(
        np.linspace(0, 6, 24)
    ).astype(int)

    refined = _refine_fixed_bpm(
        librosa,
        np,
        beat_frames,
        22050,
        150,
    )

    assert refined == pytest.approx(150, abs=0.1)


def test_fixed_tempo_comparison_corrects_half_tempo_estimate() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _steady_onset_envelope(180),
        22050,
    )

    assert bpm == pytest.approx(180, abs=0.2)
    assert len(beats) >= 85


def test_fixed_tempo_uses_evaluated_librosa_prior(monkeypatch) -> None:
    calls = {}
    original = librosa.feature.tempo

    def capture_tempo(**kwargs):
        calls.update(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(librosa.feature, "tempo", capture_tempo)

    _estimate_fixed_tempo(
        librosa,
        np,
        _steady_onset_envelope(116),
        22050,
    )

    assert calls["start_bpm"] == 100.0
    assert calls["std_bpm"] == 1.0


def test_fixed_tempo_comparison_does_not_double_slow_tempo() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _steady_onset_envelope(60),
        22050,
    )

    assert bpm == pytest.approx(60, abs=0.2)
    assert 25 <= len(beats) <= 32


def test_fixed_tempo_rejects_strong_alternating_subdivisions() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _half_time_accented_onset_envelope(172),
        22050,
    )

    assert bpm == pytest.approx(86, abs=0.2)
    assert 40 <= len(beats) <= 45


def test_fixed_tempo_does_not_promote_medium_tempo_to_fast_subdivision() -> None:
    bpm, beats = _estimate_fixed_tempo(
        librosa,
        np,
        _steady_onset_envelope(116),
        22050,
    )

    assert bpm == pytest.approx(116, abs=0.2)
    assert 55 <= len(beats) <= 60


@pytest.mark.parametrize(
    ("filename", "expected_bpm", "tolerance"),
    [
        ("bpm84.m4a", 84.0, 3.0),
        ("bpm116.mp3", 116.0, 1.0),
        ("bpm150.mp3", 150.0, 1.0),
        ("bpm164or167.wav", 164.0, 1.0),
        ("bpm172.wav", 172.0, 0.6),
        ("bpm173.wav", 173.0, 0.6),
    ],
)
def test_real_tempo_fixture_detects_full_tempo(
    filename: str,
    expected_bpm: float,
    tolerance: float,
    tmp_path: Path,
) -> None:
    path = Path(__file__).with_name(filename)
    if not path.exists():
        pytest.skip(f"Local tempo fixture is not available: {filename}")

    analysis_path = path
    if path.suffix.lower() != ".wav":
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            pytest.skip("圧縮音源の試験にはFFmpegが必要です")
        analysis_path = prepare_analysis_audio(
            path,
            tmp_path / "audio-cache",
            ffmpeg_executable=ffmpeg,
        )

    estimate = estimate_tempo(
        analysis_path,
        numerator=4,
        denominator=4,
    )

    assert estimate.bpm == pytest.approx(expected_bpm, abs=tolerance)
    assert 0 <= estimate.beat_offset_sec < 4 * 60 / estimate.bpm
