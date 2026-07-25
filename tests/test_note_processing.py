import pytest

from earcopy_service.models import Note
from earcopy_service.note_processing import (
    MINIMUM_NOTE_DURATION_SEC,
    NoteEndEvent,
    NoteEventAssembler,
    NoteStartEvent,
    reassign_notes,
)
from earcopy_service.presets import PRESET_BY_KEY, create_project


def test_note_events_are_joined_by_event_index() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})

    assert (
        assembler.feed(
            NoteStartEvent(
                event_index=7,
                instrument_id="acoustic_piano",
                pitch=64,
                start_sec=1.25,
            )
        )
        is None
    )
    note = assembler.feed(NoteEndEvent(event_index=7, end_sec=1.75))

    assert note is not None
    assert note.track_id == track.id
    assert note.pitch == 64
    assert assembler.pending_count == 0


@pytest.mark.parametrize("end_sec", [1.25, 1.0])
def test_invalid_note_end_is_clamped_to_minimum_duration(end_sec: float) -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )

    note = assembler.feed(NoteEndEvent(event_index=7, end_sec=end_sec))

    assert note is not None
    assert note.raw_end_sec == pytest.approx(
        1.25 + MINIMUM_NOTE_DURATION_SEC
    )
    assert note.end_sec == pytest.approx(1.25 + MINIMUM_NOTE_DURATION_SEC)
    assert assembler.corrected_count == 1
    assert assembler.pending_count == 0


def test_orphan_end_and_unfinished_start_are_discarded() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})

    assert assembler.feed(NoteEndEvent(event_index=99, end_sec=1.0)) is None
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )

    assert assembler.discard_pending() == 1
    assert assembler.pending_count == 0
    assert assembler.discarded_count == 2


def test_reassignment_moving_note_overwrites_existing_duplicate() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    source, target = project.tracks[0], project.tracks[1]
    existing = Note(
        sourceInstrumentId=target.instrument_id,
        trackId=target.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=1.4,
        startSec=1.0,
        endSec=1.4,
    )
    moved = Note(
        sourceInstrumentId=source.instrument_id,
        trackId=source.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=2.0,
        startSec=1.0,
        endSec=2.0,
    )

    result = reassign_notes([existing, moved], {moved.id}, target.id, bpm=120)

    assert len(result.notes) == 1
    assert result.notes[0].id == moved.id
    assert result.notes[0].track_id == target.id
    assert result.selected_note_ids == {moved.id}


def test_longest_selected_note_wins_when_selection_collides() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    source, target = project.tracks[0], project.tracks[1]
    notes = [
        Note(
            sourceInstrumentId=source.instrument_id,
            trackId=source.id,
            pitch=62,
            rawStartSec=1.0,
            rawEndSec=end,
            startSec=1.0,
            endSec=end,
        )
        for end in (1.5, 2.0)
    ]

    result = reassign_notes(notes, {note.id for note in notes}, target.id, bpm=120)

    assert len(result.notes) == 1
    assert result.notes[0].end_sec == 2.0
