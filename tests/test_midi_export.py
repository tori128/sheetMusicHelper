from mido import MidiFile

from earcopy_service.midi_export import export_midi
from earcopy_service.models import Note
from earcopy_service.presets import PRESET_BY_KEY, create_project


def test_format_one_midi_contains_conductor_and_part_tracks(tmp_path) -> None:
    project = create_project("MIDI test", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    drums = project.tracks[-1]
    project.notes = [
        Note(
            sourceInstrumentId=piano.instrument_id,
            trackId=piano.id,
            pitch=60,
            rawStartSec=0,
            rawEndSec=0.5,
            startSec=0,
            endSec=0.5,
        ),
        Note(
            sourceInstrumentId=drums.instrument_id,
            trackId=drums.id,
            pitch=36,
            rawStartSec=0,
            rawEndSec=0.25,
            startSec=0,
            endSec=0.25,
        ),
    ]
    path = tmp_path / "test.mid"

    export_midi(project, path)
    midi = MidiFile(path)

    assert midi.type == 1
    assert midi.ticks_per_beat == 480
    assert len(midi.tracks) == len(project.tracks) + 1
    assert any(message.type == "set_tempo" for message in midi.tracks[0])
    assert any(
        message.type == "note_on" and message.channel == 9
        for message in midi.tracks[-1]
    )
    vocal_index = next(
        index
        for index, track in enumerate(project.tracks, start=1)
        if track.instrument_id == "voice"
    )
    assert any(
        message.type == "program_change" and message.program == 71
        for message in midi.tracks[vocal_index]
    )


def test_midi_uses_score_origin_and_key_signature(tmp_path) -> None:
    project = create_project("MIDI timing", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.5
    project.score.key_fifths = -2
    project.score.key_mode = "minor"
    project.notes = [
        Note(
            sourceInstrumentId=piano.instrument_id,
            trackId=piano.id,
            pitch=60,
            rawStartSec=0.75,
            rawEndSec=1.25,
            startSec=0.75,
            endSec=1.25,
        )
    ]
    path = tmp_path / "timing.mid"

    export_midi(project, path)
    midi = MidiFile(path)
    note_on = next(message for message in midi.tracks[1] if message.type == "note_on")

    assert note_on.time == 240
    assert any(
        message.type == "key_signature" and message.key == "Gm"
        for message in midi.tracks[0]
    )


def test_export_preserves_current_note_timing(tmp_path) -> None:
    project = create_project("MIDI timing", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.1
    project.tempo.quantize_grid = "1/4"
    project.notes = [
        Note(
            sourceInstrumentId=piano.instrument_id,
            trackId=piano.id,
            pitch=60,
            rawStartSec=0.36,
            rawEndSec=0.86,
            startSec=0.36,
            endSec=0.86,
        )
    ]
    path = tmp_path / "current.mid"

    export_midi(project, path)

    midi = MidiFile(path)
    note_on = next(
        message for message in midi.tracks[1] if message.type == "note_on"
    )
    note_off = next(
        message for message in midi.tracks[1] if message.type == "note_off"
    )
    assert note_on.time == 250
    assert note_off.time == 480
