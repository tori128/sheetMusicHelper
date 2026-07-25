from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from .models import PPQ, Note, Project, Track
from .timebase import GRID_TICKS, quantize_tick, seconds_to_ticks

DIVISIONS = PPQ
MUSICXML_DOCTYPE = (
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
    '"http://www.musicxml.org/dtds/partwise.dtd">'
)
BASS_CLEF_INSTRUMENTS = {
    "cello",
    "contrabass",
    "electric_bass",
    "acoustic_bass",
    "bassoon",
    "tuba",
    "baritone_sax",
}
NOTE_NOTATIONS: dict[int, tuple[str, int, tuple[int, int] | None]] = {
    1920: ("whole", 0, None),
    1440: ("half", 1, None),
    1280: ("whole", 0, (3, 2)),
    960: ("half", 0, None),
    720: ("quarter", 1, None),
    640: ("half", 0, (3, 2)),
    480: ("quarter", 0, None),
    360: ("eighth", 1, None),
    320: ("quarter", 0, (3, 2)),
    240: ("eighth", 0, None),
    180: ("16th", 1, None),
    160: ("eighth", 0, (3, 2)),
    120: ("16th", 0, None),
    90: ("32nd", 1, None),
    80: ("16th", 0, (3, 2)),
    60: ("32nd", 0, None),
    40: ("32nd", 0, (3, 2)),
}
DRUM_DISPLAY = {
    35: ("F", 3, "normal"),
    36: ("F", 3, "normal"),
    38: ("C", 5, "normal"),
    40: ("C", 5, "normal"),
    41: ("F", 4, "normal"),
    43: ("A", 4, "normal"),
    45: ("C", 5, "normal"),
    47: ("D", 5, "normal"),
    48: ("E", 5, "normal"),
    50: ("F", 5, "normal"),
    42: ("G", 5, "x"),
    44: ("G", 5, "x"),
    46: ("G", 5, "x"),
    49: ("A", 5, "x"),
    51: ("F", 5, "x"),
    57: ("A", 5, "x"),
    59: ("F", 5, "x"),
}


@dataclass(frozen=True, slots=True)
class _AssignedNote:
    note: Note
    start_tick: int
    end_tick: int
    voice: int


@dataclass(frozen=True, slots=True)
class _Segment:
    note: Note
    start_tick: int
    end_tick: int
    voice: int
    tie_start: bool
    tie_stop: bool


def _child(parent: ET.Element, tag: str, text: str | int | float) -> ET.Element:
    element = ET.SubElement(parent, tag)
    element.text = str(text)
    return element


def _measure_ticks(project: Project) -> int:
    signature = project.tempo.time_signature
    return (
        project.tempo.ppq
        * signature.numerator
        * 4
        // signature.denominator
    )


def _quantized_note_ticks(project: Project, note: Note) -> tuple[int, int]:
    grid_tick = GRID_TICKS[project.tempo.quantize_grid]
    phase_tick = seconds_to_ticks(
        project.tempo.beat_offset_sec,
        project.tempo.bpm,
        project.tempo.ppq,
    )

    def snap(seconds: float) -> int:
        raw_tick = seconds_to_ticks(
            seconds,
            project.tempo.bpm,
            project.tempo.ppq,
        )
        return max(
            0,
            phase_tick + quantize_tick(raw_tick - phase_tick, grid_tick),
        )

    start_tick = snap(note.start_sec)
    return start_tick, max(start_tick + grid_tick, snap(note.end_sec))


def _assign_voices(project: Project, track: Track) -> list[_AssignedNote]:
    grouped: dict[int, list[tuple[Note, int]]] = defaultdict(list)
    for note in project.notes:
        if note.track_id != track.id:
            continue
        start, end = _quantized_note_ticks(project, note)
        grouped[start].append((note, end))

    voice_ends: list[int] = []
    assigned: list[_AssignedNote] = []
    for start in sorted(grouped):
        chord = grouped[start]
        chord_end = max(end for _note, end in chord)
        voice = next(
            (
                index
                for index, voice_end in enumerate(voice_ends)
                if voice_end <= start
            ),
            len(voice_ends),
        )
        if voice == len(voice_ends):
            voice_ends.append(chord_end)
        else:
            voice_ends[voice] = chord_end
        for note, end in sorted(
            chord,
            key=lambda item: (item[1], item[0].pitch),
            reverse=True,
        ):
            assigned.append(
                _AssignedNote(
                    note=note,
                    start_tick=start,
                    end_tick=end,
                    voice=voice + 1,
                )
            )
    return assigned


def _split_into_measures(
    notes: list[_AssignedNote],
    measure_ticks: int,
) -> dict[int, list[_Segment]]:
    measures: dict[int, list[_Segment]] = defaultdict(list)
    for assigned in notes:
        cursor = assigned.start_tick
        while cursor < assigned.end_tick:
            measure_index = cursor // measure_ticks
            boundary = (measure_index + 1) * measure_ticks
            segment_end = min(assigned.end_tick, boundary)
            measures[measure_index].append(
                _Segment(
                    note=assigned.note,
                    start_tick=cursor,
                    end_tick=segment_end,
                    voice=assigned.voice,
                    tie_start=segment_end < assigned.end_tick,
                    tie_stop=cursor > assigned.start_tick,
                )
            )
            cursor = segment_end
    return measures


def _pitch(parent: ET.Element, midi_pitch: int) -> None:
    names = (
        ("C", 0),
        ("C", 1),
        ("D", 0),
        ("D", 1),
        ("E", 0),
        ("F", 0),
        ("F", 1),
        ("G", 0),
        ("G", 1),
        ("A", 0),
        ("A", 1),
        ("B", 0),
    )
    step, alter = names[midi_pitch % 12]
    pitch = ET.SubElement(parent, "pitch")
    _child(pitch, "step", step)
    if alter:
        _child(pitch, "alter", alter)
    _child(pitch, "octave", midi_pitch // 12 - 1)


def _unpitched(parent: ET.Element, midi_pitch: int) -> str:
    step, octave, notehead = DRUM_DISPLAY.get(midi_pitch, ("C", 5, "normal"))
    unpitched = ET.SubElement(parent, "unpitched")
    _child(unpitched, "display-step", step)
    _child(unpitched, "display-octave", octave)
    return notehead


def _append_notation_duration(parent: ET.Element, duration: int) -> None:
    notation = NOTE_NOTATIONS.get(duration)
    if notation is None:
        return
    note_type, dot_count, time_modification = notation
    _child(parent, "type", note_type)
    for _ in range(dot_count):
        ET.SubElement(parent, "dot")
    if time_modification is not None:
        actual_notes, normal_notes = time_modification
        modification = ET.SubElement(parent, "time-modification")
        _child(modification, "actual-notes", actual_notes)
        _child(modification, "normal-notes", normal_notes)


def _append_rest(
    parent: ET.Element,
    duration: int,
    voice: int,
    *,
    full_measure: bool = False,
) -> None:
    if duration <= 0:
        return
    note = ET.SubElement(parent, "note")
    rest = ET.SubElement(note, "rest")
    if full_measure:
        rest.set("measure", "yes")
    _child(note, "duration", duration)
    _child(note, "voice", voice)
    if not full_measure:
        _append_notation_duration(note, duration)


def _append_note(
    parent: ET.Element,
    segment: _Segment,
    track: Track,
    part_id: str,
    chord: bool,
) -> None:
    note = ET.SubElement(parent, "note")
    if chord:
        ET.SubElement(note, "chord")
    notehead = "normal"
    if track.kind == "drums":
        notehead = _unpitched(note, segment.note.pitch)
    else:
        _pitch(note, segment.note.pitch)
    duration = segment.end_tick - segment.start_tick
    _child(note, "duration", duration)
    for tie_type, enabled in (
        ("stop", segment.tie_stop),
        ("start", segment.tie_start),
    ):
        if enabled:
            ET.SubElement(note, "tie", type=tie_type)
    instrument_id = (
        f"{part_id}-I{segment.note.pitch}"
        if track.kind == "drums"
        else f"{part_id}-I1"
    )
    ET.SubElement(note, "instrument", id=instrument_id)
    _child(note, "voice", segment.voice)
    _append_notation_duration(note, duration)
    if track.kind == "drums":
        _child(note, "notehead", notehead)
    if segment.tie_start or segment.tie_stop:
        notations = ET.SubElement(note, "notations")
        if segment.tie_stop:
            ET.SubElement(notations, "tied", type="stop")
        if segment.tie_start:
            ET.SubElement(notations, "tied", type="start")


def _append_attributes(
    measure: ET.Element,
    project: Project,
    track: Track,
) -> None:
    attributes = ET.SubElement(measure, "attributes")
    _child(attributes, "divisions", DIVISIONS)
    key = ET.SubElement(attributes, "key")
    _child(key, "fifths", 0)
    signature = project.tempo.time_signature
    time = ET.SubElement(attributes, "time")
    _child(time, "beats", signature.numerator)
    _child(time, "beat-type", signature.denominator)
    clef = ET.SubElement(attributes, "clef")
    if track.kind == "drums":
        _child(clef, "sign", "percussion")
        _child(clef, "line", 2)
    elif track.instrument_id == "viola":
        _child(clef, "sign", "C")
        _child(clef, "line", 3)
    elif track.instrument_id in BASS_CLEF_INSTRUMENTS:
        _child(clef, "sign", "F")
        _child(clef, "line", 4)
    else:
        _child(clef, "sign", "G")
        _child(clef, "line", 2)


def _append_tempo(measure: ET.Element, bpm: float) -> None:
    direction = ET.SubElement(measure, "direction", placement="above")
    direction_type = ET.SubElement(direction, "direction-type")
    metronome = ET.SubElement(direction_type, "metronome")
    _child(metronome, "beat-unit", "quarter")
    _child(metronome, "per-minute", f"{bpm:g}")
    ET.SubElement(direction, "sound", tempo=f"{bpm:g}")


def _score_tracks(project: Project) -> list[Track]:
    tracks = sorted(project.tracks, key=lambda item: item.order)
    if not tracks:
        raise ValueError("MusicXMLへ出力できるトラックがありません")
    tracks_with_notes = {
        note.track_id
        for note in project.notes
    }
    populated = [track for track in tracks if track.id in tracks_with_notes]
    return populated or tracks[:1]


def _append_part_list(
    root: ET.Element,
    project: Project,
    tracks: list[Track],
) -> list[tuple[str, Track]]:
    part_list = ET.SubElement(root, "part-list")
    parts: list[tuple[str, Track]] = []
    for index, track in enumerate(tracks, 1):
        part_id = f"P{index}"
        parts.append((part_id, track))
        score_part = ET.SubElement(part_list, "score-part", id=part_id)
        _child(score_part, "part-name", track.display_name)
        if track.kind == "drums":
            pitches = sorted(
                {
                    note.pitch
                    for note in project.notes
                    if note.track_id == track.id
                }
            )
            for pitch in pitches:
                instrument_id = f"{part_id}-I{pitch}"
                score_instrument = ET.SubElement(
                    score_part,
                    "score-instrument",
                    id=instrument_id,
                )
                _child(score_instrument, "instrument-name", f"GM Percussion {pitch}")
            for pitch in pitches:
                instrument_id = f"{part_id}-I{pitch}"
                midi_instrument = ET.SubElement(
                    score_part,
                    "midi-instrument",
                    id=instrument_id,
                )
                _child(midi_instrument, "midi-channel", 10)
                _child(midi_instrument, "midi-unpitched", pitch + 1)
        else:
            instrument_id = f"{part_id}-I1"
            score_instrument = ET.SubElement(
                score_part,
                "score-instrument",
                id=instrument_id,
            )
            _child(score_instrument, "instrument-name", track.display_name)
            midi_instrument = ET.SubElement(
                score_part,
                "midi-instrument",
                id=instrument_id,
            )
            _child(midi_instrument, "midi-channel", track.midi_channel)
            _child(midi_instrument, "midi-program", (track.gm_program or 0) + 1)
    return parts


def build_musicxml(project: Project) -> ET.ElementTree:
    root = ET.Element("score-partwise", version="4.0")
    work = ET.SubElement(root, "work")
    _child(work, "work-title", project.name)
    tracks = _score_tracks(project)
    parts = _append_part_list(root, project, tracks)
    measure_ticks = _measure_ticks(project)
    assigned_by_track = {
        track.id: _assign_voices(project, track)
        for track in tracks
    }
    note_end = max(
        (
            assigned.end_tick
            for assigned_notes in assigned_by_track.values()
            for assigned in assigned_notes
        ),
        default=0,
    )
    measure_count = max(1, math.ceil(note_end / measure_ticks))

    for part_id, track in parts:
        part = ET.SubElement(root, "part", id=part_id)
        assigned = assigned_by_track[track.id]
        by_measure = _split_into_measures(assigned, measure_ticks)
        for measure_index in range(measure_count):
            measure = ET.SubElement(part, "measure", number=str(measure_index + 1))
            if measure_index == 0:
                _append_attributes(measure, project, track)
                _append_tempo(measure, project.tempo.bpm)
            measure_start = measure_index * measure_ticks
            segments = by_measure.get(measure_index, [])
            measure_max_voice = max(
                (segment.voice for segment in segments),
                default=1,
            )
            for voice in range(1, measure_max_voice + 1):
                if voice > 1:
                    backup = ET.SubElement(measure, "backup")
                    _child(backup, "duration", measure_ticks)
                voice_segments = sorted(
                    (item for item in segments if item.voice == voice),
                    key=lambda item: (
                        item.start_tick,
                        -(item.end_tick - item.start_tick),
                        item.note.pitch,
                    ),
                )
                if not voice_segments:
                    _append_rest(
                        measure,
                        measure_ticks,
                        voice,
                        full_measure=True,
                    )
                    continue
                cursor = measure_start
                for start_tick, chord_segments in _group_segments(voice_segments):
                    _append_rest(measure, start_tick - cursor, voice)
                    for index, segment in enumerate(chord_segments):
                        _append_note(
                            measure,
                            segment,
                            track,
                            part_id,
                            chord=index > 0,
                        )
                    cursor = max(item.end_tick for item in chord_segments)
                _append_rest(
                    measure,
                    measure_start + measure_ticks - cursor,
                    voice,
                )
    ET.indent(root, space="  ")
    return ET.ElementTree(root)


def _group_segments(
    segments: list[_Segment],
) -> list[tuple[int, list[_Segment]]]:
    grouped: dict[int, list[_Segment]] = defaultdict(list)
    for segment in segments:
        grouped[segment.start_tick].append(segment)
    return [(start, grouped[start]) for start in sorted(grouped)]


def export_musicxml(project: Project, path: Path) -> None:
    if path.suffix.lower() != ".musicxml":
        raise ValueError("MusicXML出力の拡張子は.musicxmlである必要があります")
    path.parent.mkdir(parents=True, exist_ok=True)
    root = build_musicxml(project).getroot()
    xml = ET.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
    )
    declaration_end = xml.index(b"?>") + 2
    path.write_bytes(
        xml[:declaration_end]
        + b"\n"
        + MUSICXML_DOCTYPE.encode("ascii")
        + b"\n"
        + xml[declaration_end:].lstrip()
    )
