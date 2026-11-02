from uuid import uuid4

from earcopy_service.models import Note, Project
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.timebase import (
    quantize_project,
    seconds_to_ticks,
    ticks_to_seconds,
)


def test_seconds_tick_round_trip() -> None:
    assert seconds_to_ticks(1.0, 120.0) == 960
    assert ticks_to_seconds(960, 120.0) == 1.0


def test_quantize_project_enforces_minimum_duration() -> None:
    project = create_project("test", PRESET_BY_KEY["string-quartet"])
    track_id = project.tracks[0].id
    project.notes = [
        Note(
            sourceInstrumentId="violin",
            trackId=track_id,
            pitch=60,
            rawStartSec=0.13,
            rawEndSec=0.14,
            startSec=0.13,
            endSec=0.14,
        )
    ]

    quantized = quantize_project(project, "1/16")

    assert seconds_to_ticks(quantized.notes[0].start_sec, 120) == 120
    assert seconds_to_ticks(quantized.notes[0].end_sec, 120) == 240
    assert quantized.tempo.quantize_grid == "1/16"


def test_quantize_project_uses_analyzed_beat_offset() -> None:
    project = create_project("test", PRESET_BY_KEY["string-quartet"])
    project.tempo.beat_offset_sec = 0.1
    track_id = project.tracks[0].id
    project.notes = [
        Note(
            sourceInstrumentId="violin",
            trackId=track_id,
            pitch=60,
            rawStartSec=0.34,
            rawEndSec=0.57,
            startSec=0.34,
            endSec=0.57,
        )
    ]

    quantized = quantize_project(project, "1/8")

    assert quantized.notes[0].start_sec == 0.35
    assert quantized.notes[0].end_sec == 0.6
