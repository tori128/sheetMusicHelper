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

