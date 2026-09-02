import json
from pathlib import Path

import pytest

from scripts.evaluate_tempo_downbeat import (
    annotation_path,
    match_events,
    periodic_events,
    read_annotations,
    reference_bpm,
    select_split,
)


def test_read_annotations_parses_time_and_beat_label(tmp_path: Path) -> None:
    path = tmp_path / "track.beats"
    path.write_text("0.2\t1\n0.7\t2\n1.2\t3\n", encoding="utf-8")

    times, labels = read_annotations(path)

    assert times == [0.2, 0.7, 1.2]
    assert labels == [1, 2, 3]


def test_match_events_requires_one_to_one_matches() -> None:
    metrics = match_events(
        [0.5, 1.0],
        [0.45, 0.52, 1.2],
        tolerance_sec=0.07,
    )

    assert metrics.reference_count == 2
    assert metrics.predicted_count == 3
    assert metrics.matched_count == 1
    assert metrics.precision == pytest.approx(1 / 3)
    assert metrics.recall == pytest.approx(1 / 2)
    assert metrics.f1 == pytest.approx(0.4)


def test_periodic_events_normalizes_phase() -> None:
    assert periodic_events(1.1, 0.5, 1.5) == pytest.approx(
        [0.1, 0.6, 1.1]
    )


def test_reference_bpm_uses_median_interval() -> None:
    assert reference_bpm([0.0, 0.5, 1.0, 1.7]) == pytest.approx(120.0)


def test_annotation_path_maps_gtzan_audio_name() -> None:
    root = Path("annotations")

    assert annotation_path(root, Path("blues/blues.00003.wav")) == (
        root / "gtzan_blues_00003.beats"
    )


def test_select_split_alternates_tracks_within_each_genre() -> None:
    paths = [
        Path("blues/blues.00000.wav"),
        Path("blues/blues.00001.wav"),
        Path("jazz/jazz.00000.wav"),
        Path("jazz/jazz.00001.wav"),
    ]

    assert select_split(paths, "development") == [paths[0], paths[2]]
    assert select_split(paths, "evaluation") == [paths[1], paths[3]]


def test_recorded_evaluation_uses_untouched_tracks() -> None:
    repository_root = Path(__file__).resolve().parents[1]
    result = json.loads(
        (
            repository_root
            / "docs/benchmarks/data/gtzan-mini-tempo-downbeat.json"
        ).read_text(encoding="utf-8")
    )

    assert result["dataset"]["trackCount"] == 100
    assert result["dataset"]["referenceBeatCount"] == 5719
    assert result["evaluation"]["developmentTrackCount"] == 50
    assert result["evaluation"]["evaluationTrackCount"] == 50
    assert result["current"]["evaluation"][
        "tempoAccuracyWithin4Percent"
    ] == 0.72
    assert result["current"]["evaluation"][
        "downbeatMacroF1"
    ] == pytest.approx(0.2665109354413702)
