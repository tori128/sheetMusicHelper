from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from xml.etree import ElementTree as ET

from .models import PPQ, Note, Project, Track
from .timebase import note_score_ticks, quantize_project, score_time_to_ticks

DIVISIONS = PPQ
DRUM_DEFAULT_DURATION = DIVISIONS // 2
MUSICXML_PREVIEW_MEASURE_LIMIT = 16
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
    35: ("F", 4, "normal"),
    36: ("F", 4, "normal"),
    37: ("C", 5, "x"),
    38: ("C", 5, "normal"),
    39: ("D", 5, "x"),
    40: ("C", 5, "normal"),
    41: ("G", 4, "normal"),
    43: ("A", 4, "normal"),
    45: ("B", 4, "normal"),
    47: ("D", 5, "normal"),
    48: ("E", 5, "normal"),
    50: ("F", 5, "normal"),
    42: ("G", 5, "x"),
    44: ("D", 4, "x"),
    46: ("G", 5, "circle-x"),
    49: ("A", 5, "x"),
    51: ("F", 5, "x"),
    52: ("B", 5, "x"),
    53: ("F", 5, "diamond"),
    54: ("C", 6, "x"),
    55: ("B", 5, "x"),
    56: ("D", 6, "diamond"),
    57: ("A", 5, "x"),
    58: ("E", 6, "diamond"),
    59: ("F", 5, "x"),
    60: ("G", 5, "normal"),
    61: ("F", 5, "normal"),
    62: ("E", 5, "normal"),
    63: ("F", 5, "normal"),
    64: ("D", 5, "normal"),
    65: ("G", 5, "normal"),
    66: ("F", 5, "normal"),
    67: ("G", 5, "normal"),
    68: ("F", 5, "normal"),
    69: ("C", 6, "x"),
    70: ("D", 6, "x"),
    71: ("E", 6, "x"),
    72: ("F", 6, "x"),
    73: ("G", 6, "x"),
    74: ("A", 6, "x"),
    75: ("B", 5, "x"),
    76: ("C", 6, "normal"),
    77: ("B", 5, "normal"),
    78: ("D", 6, "x"),
    79: ("C", 6, "x"),
    80: ("B", 5, "diamond"),
    81: ("A", 5, "diamond"),
}
CHORD_KINDS = {
    "": "major",
    "m": "minor",
    "6": "major-sixth",
    "m6": "minor-sixth",
    "7": "dominant",
    "maj7": "major-seventh",
    "m7": "minor-seventh",
    "m7b5": "half-diminished",
    "dim": "diminished",
    "dim7": "diminished-seventh",
    "aug": "augmented",
    "sus2": "suspended-second",
    "sus4": "suspended-fourth",
    "9": "dominant-ninth",
    "maj9": "major-ninth",
    "m9": "minor-ninth",
}


@dataclass(frozen=True, slots=True)
class _AssignedNote:
    note: Note
    start_tick: int
    end_tick: int
    voice: int
    staff: int


@dataclass(frozen=True, slots=True)
class _Segment:
    note: Note
    start_tick: int
    end_tick: int
    voice: int
    staff: int
    tie_start: bool
    tie_stop: bool


@dataclass(frozen=True, slots=True)
class _MeasureSpan:
    index: int
    number: int
    start_tick: int
    end_tick: int
    implicit: bool


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


def _configured_clef(project: Project, track: Track) -> str:
    if track.kind == "drums":
        return "percussion"
    settings = project.score.track_settings.get(str(track.id))
    if settings is not None and settings.clef != "auto":
        return settings.clef
    if track.instrument_id in {"acoustic_piano", "electric_piano"}:
        return "grand"
    if track.instrument_id == "viola":
        return "alto"
    if track.instrument_id in BASS_CLEF_INSTRUMENTS:
        return "bass"
    return "treble"


def _transposition_semitones(project: Project, track: Track) -> int:
    settings = project.score.track_settings.get(str(track.id))
    return settings.transposition_semitones if settings is not None else 0


def _written_pitch(project: Project, track: Track, note: Note) -> int:
    return note.pitch + _transposition_semitones(project, track)


def _is_grand_staff(project: Project, track: Track) -> bool:
    return _configured_clef(project, track) == "grand"


def _note_staff(project: Project, track: Track, note: Note) -> int:
    return 2 if _is_grand_staff(project, track) and _written_pitch(project, track, note) < 60 else 1


def _measure_bounds_for_tick(
    project: Project,
    tick: int,
) -> tuple[int, int, int]:
    measure_ticks = _measure_ticks(project)
    pickup_ticks = project.score.pickup_ticks
    if pickup_ticks > 0 and tick < pickup_ticks:
        return 0, 0, pickup_ticks
    relative = tick - pickup_ticks if pickup_ticks > 0 else tick
    measure_index = relative // measure_ticks + (1 if pickup_ticks > 0 else 0)
    start_tick = (
        pickup_ticks + (measure_index - 1) * measure_ticks
        if pickup_ticks > 0
        else measure_index * measure_ticks
    )
    return measure_index, start_tick, start_tick + measure_ticks


def _measure_spans(project: Project, note_end: int) -> list[_MeasureSpan]:
    spans: list[_MeasureSpan] = []
    pickup_ticks = project.score.pickup_ticks
    measure_ticks = _measure_ticks(project)
    cursor = 0
    if pickup_ticks > 0:
        spans.append(_MeasureSpan(0, 0, 0, pickup_ticks, True))
        cursor = pickup_ticks
    while cursor < max(note_end, cursor + (measure_ticks if not spans else 0)):
        index = len(spans)
        spans.append(
            _MeasureSpan(
                index=index,
                number=index if pickup_ticks > 0 else index + 1,
                start_tick=cursor,
                end_tick=cursor + measure_ticks,
                implicit=False,
            )
        )
        cursor += measure_ticks
    return spans or [_MeasureSpan(0, 1, 0, measure_ticks, False)]


def _assign_voices(project: Project, track: Track) -> list[_AssignedNote]:
    grouped: dict[tuple[int, int], list[tuple[Note, int]]] = defaultdict(list)
    for note in project.notes:
        if note.track_id != track.id:
            continue
        if track.kind == "drums" and note.pitch not in DRUM_DISPLAY:
            continue
        start, end = note_score_ticks(project, note)
        grouped[(_note_staff(project, track, note), start)].append((note, end))

    if track.kind == "drums":
        starts = sorted(start for _staff, start in grouped)
        for index, start in enumerate(starts):
            next_start = starts[index + 1] if index + 1 < len(starts) else None
            default_end = start + DRUM_DEFAULT_DURATION
            _measure_index, _measure_start, measure_end = _measure_bounds_for_tick(
                project,
                start,
            )
            notated_end = min(
                default_end,
                measure_end,
                next_start if next_start is not None else default_end,
            )
            grouped[(1, start)] = [
                (note, max(start + 1, notated_end))
                for note, _end in grouped[(1, start)]
            ]

    assigned: list[_AssignedNote] = []
    for staff in sorted({staff for staff, _start in grouped}):
        voice_ends: list[int] = []
        staff_starts = sorted(start for grouped_staff, start in grouped if grouped_staff == staff)
        for start in staff_starts:
            chord = grouped[(staff, start)]
            chord_end = max(end for _note, end in chord)
            local_voice = next(
                (
                    index
                    for index, voice_end in enumerate(voice_ends)
                    if voice_end <= start
                ),
                len(voice_ends),
            )
            if local_voice == len(voice_ends):
                voice_ends.append(chord_end)
            else:
                voice_ends[local_voice] = chord_end
            voice = local_voice + 1 + (4 if staff == 2 else 0)
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
                        voice=voice,
                        staff=staff,
                    )
                )
    return assigned


def _split_into_measures(
    notes: list[_AssignedNote],
    spans: list[_MeasureSpan],
) -> dict[int, list[_Segment]]:
    measures: dict[int, list[_Segment]] = defaultdict(list)
    chord_groups: dict[tuple[int, int, int], list[_AssignedNote]] = defaultdict(list)
    for assigned in notes:
        chord_groups[(assigned.staff, assigned.voice, assigned.start_tick)].append(assigned)

    for chord in chord_groups.values():
        chord_ends = sorted({assigned.end_tick for assigned in chord})
        for assigned in chord:
            boundaries = {
                assigned.start_tick,
                assigned.end_tick,
                *(
                    end_tick
                    for end_tick in chord_ends
                    if assigned.start_tick < end_tick < assigned.end_tick
                ),
            }
            boundaries.update(
                span.end_tick
                for span in spans
                if assigned.start_tick < span.end_tick < assigned.end_tick
            )

            cursor = assigned.start_tick
            for boundary in sorted(boundaries):
                if boundary <= cursor:
                    continue
                interval = boundary - cursor
                for duration in _notation_chunks(interval):
                    segment_end = cursor + duration
                    measure_index = next(
                        span.index
                        for span in spans
                        if span.start_tick <= cursor < span.end_tick
                    )
                    measures[measure_index].append(
                        _Segment(
                            note=assigned.note,
                            start_tick=cursor,
                            end_tick=segment_end,
                            voice=assigned.voice,
                            staff=assigned.staff,
                            tie_start=segment_end < assigned.end_tick,
                            tie_stop=cursor > assigned.start_tick,
                        )
                    )
                    cursor = segment_end
                if cursor != boundary:
                    raise ValueError(
                        "MusicXMLの音価を小節内へ分割できません"
                    )
    return measures


def _pitch(parent: ET.Element, midi_pitch: int, key_fifths: int) -> None:
    sharp_names = (
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
    flat_names = (
        ("C", 0),
        ("D", -1),
        ("D", 0),
        ("E", -1),
        ("E", 0),
        ("F", 0),
        ("G", -1),
        ("G", 0),
        ("A", -1),
        ("A", 0),
        ("B", -1),
        ("B", 0),
    )
    names = flat_names if key_fifths < 0 else sharp_names
    step, alter = names[midi_pitch % 12]
    pitch = ET.SubElement(parent, "pitch")
    _child(pitch, "step", step)
    if alter:
        _child(pitch, "alter", alter)
    _child(pitch, "octave", midi_pitch // 12 - 1)


def _unpitched(parent: ET.Element, midi_pitch: int) -> str:
    step, octave, notehead = DRUM_DISPLAY[midi_pitch]
    unpitched = ET.SubElement(parent, "unpitched")
    _child(unpitched, "display-step", step)
    _child(unpitched, "display-octave", octave)
    return notehead


@lru_cache(maxsize=None)
def _known_notation_chunks(duration: int) -> tuple[int, ...] | None:
    if duration == 0:
        return ()
    if duration < 0:
        return None

    best: tuple[int, ...] | None = None
    for candidate in sorted(NOTE_NOTATIONS, reverse=True):
        if candidate > duration:
            continue
        remainder = _known_notation_chunks(duration - candidate)
        if remainder is None:
            continue
        chunks = (candidate, *remainder)
        chunk_cost = (
            len(chunks),
            sum(
                NOTE_NOTATIONS[item][2] is not None
                for item in chunks
            ),
        )
        best_cost = (
            (
                len(best),
                sum(
                    NOTE_NOTATIONS[item][2] is not None
                    for item in best
                ),
            )
            if best is not None
            else None
        )
        if best_cost is None or chunk_cost < best_cost:
            best = chunks
    return best


def _notation_chunks(duration: int) -> tuple[int, ...]:
    if duration <= 0:
        raise ValueError("MusicXMLの音価は正数である必要があります")
    chunks = _known_notation_chunks(duration)
    return chunks if chunks is not None else (duration,)


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
    staff: int,
    *,
    full_measure: bool = False,
) -> None:
    if duration <= 0:
        return
    if full_measure:
        note = ET.SubElement(parent, "note")
        rest = ET.SubElement(note, "rest")
        rest.set("measure", "yes")
        _child(note, "duration", duration)
        _child(note, "voice", voice)
        _child(note, "staff", staff)
        return
    chunks = _known_notation_chunks(duration)
    if chunks is None:
        forward = ET.SubElement(parent, "forward")
        _child(forward, "duration", duration)
        _child(forward, "voice", voice)
        return
    for chunk in chunks:
        note = ET.SubElement(parent, "note")
        ET.SubElement(note, "rest")
        _child(note, "duration", chunk)
        _child(note, "voice", voice)
        _child(note, "staff", staff)
        _append_notation_duration(note, chunk)


def _append_note(
    parent: ET.Element,
    segment: _Segment,
    track: Track,
    project: Project,
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
        written_pitch = _written_pitch(project, track, segment.note)
        if written_pitch < 0 or written_pitch > 127:
            raise ValueError(
                f"{track.display_name}の記譜音高がMIDI範囲外です: {written_pitch}"
            )
        _pitch(note, written_pitch, project.score.key_fifths)
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
    _child(note, "staff", segment.staff)
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
    _child(key, "fifths", project.score.key_fifths)
    _child(key, "mode", project.score.key_mode)
    signature = project.tempo.time_signature
    time = ET.SubElement(attributes, "time")
    _child(time, "beats", signature.numerator)
    _child(time, "beat-type", signature.denominator)
    transposition = _transposition_semitones(project, track)
    if transposition:
        transpose = ET.SubElement(attributes, "transpose")
        _child(transpose, "chromatic", -transposition)
    clef_name = _configured_clef(project, track)
    if clef_name == "percussion":
        clef = ET.SubElement(attributes, "clef")
        _child(clef, "sign", "percussion")
        _child(clef, "line", 2)
    elif clef_name == "grand":
        _child(attributes, "staves", 2)
        upper_clef = ET.SubElement(attributes, "clef", number="1")
        _child(upper_clef, "sign", "G")
        _child(upper_clef, "line", 2)
        lower_clef = ET.SubElement(attributes, "clef", number="2")
        _child(lower_clef, "sign", "F")
        _child(lower_clef, "line", 4)
    elif clef_name in {"alto", "tenor"}:
        clef = ET.SubElement(attributes, "clef")
        _child(clef, "sign", "C")
        _child(clef, "line", 3 if clef_name == "alto" else 4)
    elif clef_name == "bass":
        clef = ET.SubElement(attributes, "clef")
        _child(clef, "sign", "F")
        _child(clef, "line", 4)
    else:
        clef = ET.SubElement(attributes, "clef")
        _child(clef, "sign", "G")
        _child(clef, "line", 2)


def _append_tempo(measure: ET.Element, bpm: float) -> None:
    direction = ET.SubElement(measure, "direction", placement="above")
    direction_type = ET.SubElement(direction, "direction-type")
    metronome = ET.SubElement(direction_type, "metronome")
    _child(metronome, "beat-unit", "quarter")
    _child(metronome, "per-minute", f"{bpm:g}")
    ET.SubElement(direction, "sound", tempo=f"{bpm:g}")


def _append_harmony(
    measure: ET.Element,
    label: str,
    offset: int,
) -> None:
    if not label or label in {"N.C.", "N.C", "-"}:
        return
    root_step = label[0].upper()
    if root_step not in "ABCDEFG":
        return
    cursor = 1
    root_alter = 0
    if len(label) > 1 and label[1] in {"#", "b"}:
        root_alter = 1 if label[1] == "#" else -1
        cursor = 2
    suffix_and_bass = label[cursor:]
    suffix, separator, bass_label = suffix_and_bass.partition("/")
    harmony = ET.SubElement(measure, "harmony")
    root = ET.SubElement(harmony, "root")
    _child(root, "root-step", root_step)
    if root_alter:
        _child(root, "root-alter", root_alter)
    kind_name = CHORD_KINDS.get(suffix, "other")
    kind = ET.SubElement(harmony, "kind")
    kind.text = kind_name
    if suffix:
        kind.set("text", suffix)
    if separator and bass_label:
        bass_step = bass_label[0].upper()
        if bass_step in "ABCDEFG":
            bass = ET.SubElement(harmony, "bass")
            _child(bass, "bass-step", bass_step)
            if len(bass_label) > 1 and bass_label[1] in {"#", "b"}:
                _child(
                    bass,
                    "bass-alter",
                    1 if bass_label[1] == "#" else -1,
                )
    if offset:
        _child(harmony, "offset", offset)


def _append_score_metadata(root: ET.Element, project: Project) -> None:
    identification = ET.SubElement(root, "identification")
    for creator_type, value in (
        ("composer", project.score.composer),
        ("arranger", project.score.arranger),
    ):
        if value:
            creator = ET.SubElement(
                identification,
                "creator",
                type=creator_type,
            )
            creator.text = value
    if project.score.copyright:
        _child(identification, "rights", project.score.copyright)


def _score_tracks(project: Project) -> list[Track]:
    tracks = sorted(project.tracks, key=lambda item: item.order)
    if not tracks:
        raise ValueError("MusicXMLへ出力できるトラックがありません")
    tracks_by_id = {track.id: track for track in tracks}
    tracks_with_notes = {
        note.track_id
        for note in project.notes
        if tracks_by_id[note.track_id].kind != "drums"
        or note.pitch in DRUM_DISPLAY
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
                    and note.pitch in DRUM_DISPLAY
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


def build_musicxml(
    project: Project,
    *,
    measure_limit: int | None = None,
) -> ET.ElementTree:
    if measure_limit is not None and measure_limit < 1:
        raise ValueError("measure_limit must be at least 1")
    root = ET.Element("score-partwise", version="4.0")
    work = ET.SubElement(root, "work")
    _child(work, "work-title", project.name)
    _append_score_metadata(root, project)
    tracks = _score_tracks(project)
    parts = _append_part_list(root, project, tracks)
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
    spans = _measure_spans(project, note_end)
    if measure_limit is not None:
        spans = spans[:measure_limit]
    preview_end_tick = spans[-1].end_tick
    score_chords = (
        [
            (score_time_to_ticks(project, chord.start_sec), chord.label)
            for chord in project.score.chords
        ]
        if project.score.include_chord_symbols
        else []
    )

    for part_index, (part_id, track) in enumerate(parts):
        part = ET.SubElement(root, "part", id=part_id)
        assigned = [
            _AssignedNote(
                note=item.note,
                start_tick=item.start_tick,
                end_tick=min(item.end_tick, preview_end_tick),
                voice=item.voice,
                staff=item.staff,
            )
            for item in assigned_by_track[track.id]
            if item.start_tick < preview_end_tick
        ]
        by_measure = _split_into_measures(assigned, spans)
        for span in spans:
            measure_attributes = {"number": str(span.number)}
            if span.implicit:
                measure_attributes["implicit"] = "yes"
            measure = ET.SubElement(part, "measure", **measure_attributes)
            if span.index == 0:
                _append_attributes(measure, project, track)
                _append_tempo(measure, project.tempo.bpm)
            if part_index == 0:
                for chord_tick, chord_label in score_chords:
                    if span.start_tick <= chord_tick < span.end_tick:
                        _append_harmony(
                            measure,
                            chord_label,
                            chord_tick - span.start_tick,
                        )
            segments = by_measure.get(span.index, [])
            default_voices = {1, 5} if _is_grand_staff(project, track) else {1}
            voices = sorted(default_voices | {segment.voice for segment in segments})
            for voice_index, voice in enumerate(voices):
                if voice_index > 0:
                    backup = ET.SubElement(measure, "backup")
                    _child(backup, "duration", span.end_tick - span.start_tick)
                voice_segments = sorted(
                    (item for item in segments if item.voice == voice),
                    key=lambda item: (
                        item.start_tick,
                        -(item.end_tick - item.start_tick),
                        item.note.pitch,
                    ),
                )
                if not voice_segments:
                    staff = 2 if voice >= 5 else 1
                    _append_rest(
                        measure,
                        span.end_tick - span.start_tick,
                        voice,
                        staff,
                        full_measure=True,
                    )
                    continue
                staff = voice_segments[0].staff
                cursor = span.start_tick
                for start_tick, chord_segments in _group_segments(voice_segments):
                    _append_rest(
                        measure,
                        start_tick - cursor,
                        voice,
                        staff,
                    )
                    for index, segment in enumerate(chord_segments):
                        _append_note(
                            measure,
                            segment,
                            track,
                            project,
                            part_id,
                            chord=index > 0,
                        )
                    cursor = max(item.end_tick for item in chord_segments)
                _append_rest(
                    measure,
                    span.end_tick - cursor,
                    voice,
                    staff,
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
    quantized_project = quantize_project(
        project,
        project.tempo.quantize_grid,
    )
    root = build_musicxml(quantized_project).getroot()
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
