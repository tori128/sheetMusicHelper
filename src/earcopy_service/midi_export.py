from __future__ import annotations

from pathlib import Path

from mido import Message, MetaMessage, MidiFile, MidiTrack, bpm2tempo

from .models import Project, Track
from .timebase import note_score_ticks

KEY_SIGNATURES = {
    (0, "major"): "C",
    (1, "major"): "G",
    (2, "major"): "D",
    (3, "major"): "A",
    (4, "major"): "E",
    (5, "major"): "B",
    (6, "major"): "F#",
    (7, "major"): "C#",
    (-1, "major"): "F",
    (-2, "major"): "Bb",
    (-3, "major"): "Eb",
    (-4, "major"): "Ab",
    (-5, "major"): "Db",
    (-6, "major"): "Gb",
    (-7, "major"): "Cb",
    (0, "minor"): "Am",
    (1, "minor"): "Em",
    (2, "minor"): "Bm",
    (3, "minor"): "F#m",
    (4, "minor"): "C#m",
    (5, "minor"): "G#m",
    (6, "minor"): "D#m",
    (7, "minor"): "A#m",
    (-1, "minor"): "Dm",
    (-2, "minor"): "Gm",
    (-3, "minor"): "Cm",
    (-4, "minor"): "Fm",
    (-5, "minor"): "Bbm",
    (-6, "minor"): "Ebm",
    (-7, "minor"): "Abm",
}


def _append_absolute_events(
    midi_track: MidiTrack,
    events: list[tuple[int, int, Message]],
) -> None:
    previous_tick = 0
    for tick, _priority, message in sorted(events, key=lambda item: (item[0], item[1])):
        message.time = tick - previous_tick
        midi_track.append(message)
        previous_tick = tick


def _create_note_track(project: Project, track: Track) -> MidiTrack:
    midi_track = MidiTrack()
    midi_track.append(MetaMessage("track_name", name=track.display_name, time=0))
    channel = track.midi_channel - 1
    events: list[tuple[int, int, Message]] = []
    if track.kind == "pitched":
        events.append(
            (
                0,
                1,
                Message(
                    "program_change",
                    program=track.gm_program,
                    channel=channel,
                    time=0,
                ),
            )
        )
    for note in project.notes:
        if note.track_id != track.id:
            continue
        start_tick, end_tick = note_score_ticks(project, note)
        events.append(
            (
                end_tick,
                0,
                Message(
                    "note_off",
                    note=note.pitch,
                    velocity=0,
                    channel=channel,
                    time=0,
                ),
            )
        )
        events.append(
            (
                start_tick,
                2,
                Message(
                    "note_on",
                    note=note.pitch,
                    velocity=note.velocity,
                    channel=channel,
                    time=0,
                ),
            )
        )
    _append_absolute_events(midi_track, events)
    midi_track.append(MetaMessage("end_of_track", time=0))
    return midi_track


def build_midi(project: Project) -> MidiFile:
    midi = MidiFile(type=1, ticks_per_beat=project.tempo.ppq)
    conductor = MidiTrack()
    conductor.append(MetaMessage("track_name", name=project.name, time=0))
    conductor.append(
        MetaMessage("set_tempo", tempo=bpm2tempo(project.tempo.bpm), time=0)
    )
    signature = project.tempo.time_signature
    conductor.append(
        MetaMessage(
            "time_signature",
            numerator=signature.numerator,
            denominator=signature.denominator,
            time=0,
        )
    )
    conductor.append(
        MetaMessage(
            "key_signature",
            key=KEY_SIGNATURES[(project.score.key_fifths, project.score.key_mode)],
            time=0,
        )
    )
    conductor.append(MetaMessage("end_of_track", time=0))
    midi.tracks.append(conductor)
    for track in sorted(project.tracks, key=lambda item: item.order):
        midi.tracks.append(_create_note_track(project, track))
    return midi


def export_midi(project: Project, path: Path) -> None:
    if path.suffix.lower() not in {".mid", ".midi"}:
        raise ValueError("MIDI出力の拡張子は.midまたは.midiである必要があります")
    path.parent.mkdir(parents=True, exist_ok=True)
    build_midi(project).save(path)
