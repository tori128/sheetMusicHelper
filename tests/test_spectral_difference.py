from pathlib import Path

import numpy
import soundfile

from earcopy_service.spectral_difference import calculate_spectral_difference


SAMPLE_RATE = 22_050


def _sine(frequency_hz: float, duration_sec: float) -> numpy.ndarray:
    time = numpy.arange(round(duration_sec * SAMPLE_RATE)) / SAMPLE_RATE
    return numpy.sin(2 * numpy.pi * frequency_hz * time).astype(numpy.float32)


def _write(path: Path, audio: numpy.ndarray) -> None:
    soundfile.write(path, audio, SAMPLE_RATE, subtype="FLOAT")


def _calculate(source: Path, synthesized: Path, duration_sec: float = 2.0):
    return calculate_spectral_difference(
        [source],
        synthesized,
        duration_sec=duration_sec,
        timeline_offset_sec=0.0,
        bpm=60.0,
        beat_offset_sec=0.0,
        numerator=4,
        denominator=4,
    )


def test_gain_difference_does_not_change_spectral_difference(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = _sine(440.0, 2.0)
    _write(source_path, source)
    _write(synthesized_path, source * 0.2)

    result = _calculate(source_path, synthesized_path)

    assert len(result.intervals) == 2
    assert result.maximum < 0.001


def test_pitch_difference_is_reported_in_affected_beat(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate([_sine(440.0, 1.0), _sine(440.0, 1.0)])
    synthesized = numpy.concatenate(
        [_sine(440.0, 1.0), _sine(880.0, 1.0)]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path)

    assert result.intervals[0].value < 0.08
    assert result.intervals[1].value > 0.5
    assert result.maximum == result.intervals[1].value


def test_source_timeline_offset_is_applied_before_comparison(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = _sine(440.0, 1.0)
    synthesized = numpy.concatenate(
        [numpy.zeros(SAMPLE_RATE // 2, dtype=numpy.float32), source]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = calculate_spectral_difference(
        [source_path],
        synthesized_path,
        duration_sec=1.5,
        timeline_offset_sec=0.5,
        bpm=120.0,
        beat_offset_sec=0.5,
        numerator=4,
        denominator=4,
    )

    assert len(result.intervals) == 2
    assert result.maximum < 0.001


def test_sound_on_only_one_side_has_maximum_difference(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    _write(source_path, _sine(440.0, 2.0))
    _write(synthesized_path, numpy.zeros(SAMPLE_RATE * 2, dtype=numpy.float32))

    result = _calculate(source_path, synthesized_path)

    assert all(interval.value > 0.98 for interval in result.intervals)


def test_quiet_sound_on_only_one_side_has_low_difference(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate(
        [_sine(440.0, 1.0), _sine(440.0, 1.0) * 0.01]
    )
    synthesized = numpy.concatenate(
        [_sine(440.0, 1.0), numpy.zeros(SAMPLE_RATE, dtype=numpy.float32)]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path)

    assert result.intervals[0].value < 0.1
    assert 0.1 < result.intervals[1].value < 0.3


def test_quiet_pitch_difference_has_low_difference(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate(
        [_sine(440.0, 1.0), _sine(440.0, 1.0) * 0.01]
    )
    synthesized = numpy.concatenate(
        [_sine(440.0, 1.0), _sine(880.0, 1.0) * 0.01]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path)

    assert 0.1 < result.intervals[1].value < 0.4


def test_extra_sound_in_silent_source_beat_is_reported(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate(
        [_sine(440.0, 1.0), numpy.zeros(SAMPLE_RATE, dtype=numpy.float32)]
    )
    synthesized = numpy.concatenate(
        [_sine(440.0, 1.0), _sine(660.0, 1.0) * 0.1]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path)

    assert result.intervals[0].value < 0.08
    assert result.intervals[1].value > 0.5


def test_time_order_within_beat_changes_difference(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate(
        [
            _sine(440.0, 0.5) * 0.8,
            _sine(880.0, 0.5) * 0.8,
            _sine(330.0, 1.0),
        ]
    )
    synthesized = numpy.concatenate(
        [
            _sine(880.0, 0.5) * 0.8,
            _sine(440.0, 0.5) * 0.8,
            _sine(330.0, 1.0),
        ]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path)

    assert result.intervals[0].value > 0.8
    assert result.intervals[1].value < 0.08


def test_low_frequency_semitone_difference_is_reported(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate(
        [_sine(82.4069, 1.0), _sine(82.4069, 1.0)]
    )
    synthesized = numpy.concatenate(
        [_sine(82.4069, 1.0), _sine(87.3071, 1.0)]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path)

    assert result.intervals[0].value < 0.08
    assert result.intervals[1].value > 0.5


def test_audio_below_analysis_floor_is_treated_as_silence(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    synthesized_path = tmp_path / "synthesized.wav"
    source = numpy.concatenate(
        [_sine(440.0, 1.0), _sine(440.0, 2.0) * 0.002]
    )
    synthesized = numpy.concatenate(
        [
            _sine(440.0, 1.0),
            numpy.zeros(SAMPLE_RATE * 2, dtype=numpy.float32),
        ]
    )
    _write(source_path, source)
    _write(synthesized_path, synthesized)

    result = _calculate(source_path, synthesized_path, duration_sec=3.0)

    assert result.intervals[2].value == 0.0
