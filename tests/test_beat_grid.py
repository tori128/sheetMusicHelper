import numpy as np
import pytest
from muscriptor.utils.beats import BeatDetectionError

from earcopy_service.beat_analysis import fit_beat_grid


def test_grid_retains_tempo_and_meter_with_missing_and_extra_beats():
    period = 60 / 136
    regular = np.round(0.62 + np.arange(580) * period, 2)
    beats = np.sort(np.concatenate((np.delete(regular, [121, 300, 301]), [88.0, 88.08])))
    downbeats = regular[::4]

    grid = fit_beat_grid(beats, downbeats)

    assert grid.bpm == pytest.approx(136, abs=0.02)
    assert grid.beats_per_bar == 4
    assert grid.first_downbeat == downbeats[0]
    np.testing.assert_array_equal(grid.beats, beats)


def test_outro_outliers_do_not_reject_a_stable_recording():
    regular = np.round(0.62 + np.arange(560) * 60 / 136, 2)
    beats = np.concatenate((regular, [249.5, 250.2, 250.28, 254.88, 255.4]))

    grid = fit_beat_grid(beats, regular[::4])

    assert grid.bpm == pytest.approx(136, abs=0.02)


def test_tempo_change_without_a_consistent_grid_is_rejected():
    beats = np.concatenate((np.arange(80) * 0.5, 40 + np.arange(80) * 0.4))

    with pytest.raises(BeatDetectionError, match="consistent tempo"):
        fit_beat_grid(beats, np.array([]))


@pytest.mark.parametrize("beats", [[], np.arange(7) * 0.5])
def test_too_few_beats_are_rejected(beats):
    with pytest.raises(BeatDetectionError, match="need at least"):
        fit_beat_grid(np.asarray(beats), np.array([]))


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1])
def test_invalid_beat_times_are_rejected(value):
    beats = np.arange(12) * 0.5
    beats[6] = value
    with pytest.raises(BeatDetectionError, match="strictly increasing"):
        fit_beat_grid(beats, np.array([]))
