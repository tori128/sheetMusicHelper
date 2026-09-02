from xml.etree import ElementTree as ET

import pytest

from earcopy_service.models import Note, ScoreChord, ScoreTrackSettings, SourceAudio
from earcopy_service.musicxml_export import build_musicxml, export_musicxml
from earcopy_service.presets import PRESET_BY_KEY, create_project


def _note(track, pitch: int, start: float, end: float) -> Note:
    return Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=pitch,
        rawStartSec=start,
        rawEndSec=end,
        startSec=start,
        endSec=end,
    )


def test_partwise_score_contains_parts_tempo_time_and_instruments() -> None:
    project = create_project("MusicXML test", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    drums = project.tracks[-1]
    project.notes = [
        _note(piano, 60, 0, 0.5),
        _note(drums, 36, 0, 0.25),
        _note(drums, 38, 0.5, 0.75),
    ]

    root = build_musicxml(project).getroot()

    assert root.tag == "score-partwise"
    assert root.attrib["version"] == "4.0"
    assert root.findtext("work/work-title") == "MusicXML test"
    score_parts = root.findall("part-list/score-part")
    assert [part.findtext("part-name") for part in score_parts] == [
        "Piano",
        "Drums",
    ]
    assert root.findtext("part/measure/attributes/divisions") == "480"
    assert root.findtext("part/measure/attributes/time/beats") == "4"
    assert root.findtext("part/measure/attributes/time/beat-type") == "4"
    assert root.find("part/measure/direction/sound[@tempo='120']") is not None
    assert root.find(
        "part-list/score-part/midi-instrument/midi-program"
    ) is not None
    assert root.find(
        "part-list/score-part/midi-instrument/midi-channel"
    ) is not None
    drum_part = root.findall("part")[-1]
    assert drum_part.findtext("measure/attributes/clef/sign") == "percussion"
    assert drum_part.find("measure/note/unpitched") is not None
    assert drum_part.find("measure/note/instrument") is not None
    drum_definition_tags = [item.tag for item in score_parts[-1]]
    assert drum_definition_tags == [
        "part-name",
        "score-instrument",
        "score-instrument",
        "midi-instrument",
        "midi-instrument",
    ]
    first_note = root.find("part/measure/note")
    assert first_note is not None
    first_note_tags = [item.tag for item in first_note]
    assert first_note_tags[:4] == ["pitch", "duration", "instrument", "voice"]


def test_drum_hits_use_eighth_notes_without_overlapping_the_next_onset() -> None:
    project = create_project("drum values", PRESET_BY_KEY["general-band"])
    drums = project.tracks[-1]
    project.notes = [
        _note(drums, 36, 0, 0.02),
        _note(drums, 42, 0.5, 0.52),
        _note(drums, 38, 0.625, 0.645),
        _note(drums, 49, 1.875, 1.895),
    ]

    measure = build_musicxml(project).getroot().find("part/measure")

    assert measure is not None
    hits = [
        note
        for note in measure.findall("note")
        if note.find("unpitched") is not None
    ]
    assert [hit.findtext("duration") for hit in hits] == [
        "240",
        "120",
        "240",
        "120",
    ]
    assert [hit.findtext("type") for hit in hits] == [
        "eighth",
        "16th",
        "eighth",
        "16th",
    ]


def test_drum_set_uses_standard_five_line_staff_positions() -> None:
    project = create_project("drum positions", PRESET_BY_KEY["general-band"])
    drums = project.tracks[-1]
    expected = {
        35: ("F", "4", "normal"),
        36: ("F", "4", "normal"),
        38: ("C", "5", "normal"),
        41: ("G", "4", "normal"),
        43: ("A", "4", "normal"),
        44: ("D", "4", "x"),
        45: ("B", "4", "normal"),
        46: ("G", "5", "circle-x"),
        47: ("D", "5", "normal"),
        48: ("E", "5", "normal"),
        49: ("A", "5", "x"),
        50: ("F", "5", "normal"),
        51: ("F", "5", "x"),
    }
    project.notes = [
        _note(drums, pitch, index * 0.25, index * 0.25 + 0.02)
        for index, pitch in enumerate(expected)
    ]

    root = build_musicxml(project).getroot()
    notes_by_pitch = {
        int(note.find("instrument").attrib["id"].rsplit("I", 1)[1]): note
        for note in root.findall("part/measure/note")
        if note.find("unpitched") is not None
    }

    assert set(notes_by_pitch) == set(expected)
    for pitch, (step, octave, notehead) in expected.items():
        note = notes_by_pitch[pitch]
        assert note.findtext("unpitched/display-step") == step
        assert note.findtext("unpitched/display-octave") == octave
        assert note.findtext("notehead") == notehead


def test_nonstandard_drum_keys_are_omitted_from_score() -> None:
    project = create_project("standard drum score", PRESET_BY_KEY["general-band"])
    drums = project.tracks[-1]
    project.notes = [
        _note(drums, 36, 0, 0.02),
        _note(drums, 39, 0.5, 0.52),
        _note(drums, 81, 1.0, 1.02),
        _note(drums, 82, 1.5, 1.52),
    ]

    root = build_musicxml(project).getroot()
    score_part = root.find("part-list/score-part")
    part = root.find("part")

    assert score_part is not None
    assert part is not None
    assert [
        item.attrib["id"]
        for item in score_part.findall("score-instrument")
    ] == ["P1-I36", "P1-I39", "P1-I81"]
    hits = [
        note
        for note in part.findall("measure/note")
        if note.find("unpitched") is not None
    ]
    assert len(hits) == 3
    assert hits[0].find("instrument").attrib["id"] == "P1-I36"


def test_measure_boundary_creates_ties_and_full_voice_rests() -> None:
    project = create_project("ties", PRESET_BY_KEY["string-quartet"])
    violin = project.tracks[0]
    project.notes = [_note(violin, 67, 1.5, 2.5)]

    part = build_musicxml(project).getroot().find("part")
    assert part is not None
    measures = part.findall("measure")

    assert len(measures) == 2
    assert measures[0].find("note/tie[@type='start']") is not None
    assert measures[1].find("note/tie[@type='stop']") is not None
    first_rests = [
        item for item in measures[0].findall("note") if item.find("rest") is not None
    ]
    second_rests = [
        item for item in measures[1].findall("note") if item.find("rest") is not None
    ]
    assert sum(int(item.findtext("duration") or "0") for item in first_rests) == 1440
    assert sum(int(item.findtext("duration") or "0") for item in second_rests) == 1440


def test_same_start_is_chord_and_overlap_uses_another_voice() -> None:
    project = create_project("voices", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [
        _note(piano, 60, 0.0, 1.5),
        _note(piano, 64, 0.0, 1.5),
        _note(piano, 67, 0.5, 1.0),
    ]

    measure = build_musicxml(project).getroot().find("part/measure")
    assert measure is not None

    pitched_notes = [
        item for item in measure.findall("note") if item.find("pitch") is not None
    ]
    assert len(pitched_notes) == 3
    assert sum(item.find("chord") is not None for item in pitched_notes) == 1
    assert {item.findtext("voice") for item in pitched_notes} == {"1", "2"}
    assert measure.find("backup/duration") is not None


def test_clefs_follow_instrument_mapping() -> None:
    project = create_project("clefs", PRESET_BY_KEY["string-quartet"])
    project.notes = [
        _note(project.tracks[0], 67, 0, 0.5),
        _note(project.tracks[1], 60, 0, 0.5),
        _note(project.tracks[2], 48, 0, 0.5),
    ]
    parts = build_musicxml(project).getroot().findall("part")

    assert parts[0].findtext("measure/attributes/clef/sign") == "G"
    assert parts[1].findtext("measure/attributes/clef/sign") == "C"
    assert parts[2].findtext("measure/attributes/clef/sign") == "F"


def test_build_preserves_edited_position_without_requantizing() -> None:
    project = create_project("edited timing", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.1
    project.tempo.quantize_grid = "1/4"
    edited = _note(piano, 60, 0.1, 0.6)
    edited.start_sec = 0.35
    edited.end_sec = 0.85
    project.notes = [edited]

    measure = build_musicxml(project).getroot().find("part/measure")

    assert measure is not None
    notes = measure.findall("note")
    assert notes[0].find("rest") is not None
    assert notes[0].findtext("duration") == "240"
    assert notes[1].find("pitch") is not None
    assert notes[1].findtext("duration") == "480"
    assert sum(
        int(note.findtext("duration") or "0")
        for note in notes
        if note.find("chord") is None and note.findtext("staff") == "1"
    ) == 1920


def test_build_preserves_millisecond_shift_without_requantizing() -> None:
    project = create_project("millisecond shift", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.1
    project.tempo.quantize_grid = "1/4"
    project.notes = [_note(piano, 60, 0.151, 0.651)]

    measure = build_musicxml(project).getroot().find("part/measure")

    assert measure is not None
    first_forward = measure.find("forward")
    assert first_forward is not None
    assert first_forward.findtext("duration") == "49"
    assert sum(
        int(item.findtext("duration") or "0")
        for item in measure
        if item.tag == "forward"
        or (
            item.tag == "note"
            and item.find("chord") is None
            and item.findtext("staff") == "1"
        )
    ) == 1920


def test_beat_phase_becomes_measure_one_and_all_durations_are_notated() -> None:
    project = create_project("phase origin", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.1
    project.notes = [
        _note(piano, 60, 0.1, 0.725),
        _note(piano, 64, 1.1, 1.475),
        _note(piano, 67, 2.1, 2.725),
        _note(piano, 72, 4.1, 4.725),
    ]

    measures = build_musicxml(project).getroot().findall("part/measure")

    assert len(measures) == 3
    first_note = measures[0].find("note")
    assert first_note is not None
    assert first_note.find("pitch") is not None
    for measure in measures:
        voice_durations: dict[str, int] = {}
        for note in measure.findall("note"):
            voice = note.findtext("voice") or "1"
            if note.find("chord") is None:
                voice_durations[voice] = voice_durations.get(voice, 0) + int(
                    note.findtext("duration") or "0"
                )
            rest = note.find("rest")
            if rest is None or rest.attrib.get("measure") != "yes":
                assert note.findtext("type") is not None
        assert set(voice_durations.values()) == {1920}
        assert measure.find("note/time-modification") is None


def test_unequal_chord_durations_share_notation_boundaries() -> None:
    project = create_project("split chord", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [
        _note(piano, 60, 0, 0.625),
        _note(piano, 64, 0, 0.75),
    ]

    measure = build_musicxml(project).getroot().find("part/measure")

    assert measure is not None
    pitched = [
        note for note in measure.findall("note") if note.find("pitch") is not None
    ]
    assert [note.findtext("duration") for note in pitched[:2]] == ["480", "480"]
    assert all(note.findtext("type") is not None for note in pitched)
    assert sum(
        int(note.findtext("duration") or "0")
        for note in measure.findall("note")
        if note.find("chord") is None and note.findtext("staff") == "1"
    ) == 1920


def test_score_ends_at_last_note_and_does_not_fill_source_audio_tail() -> None:
    project = create_project("trimmed", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.source_audio = SourceAudio(
        absolutePath="C:/audio.wav",
        sha256="a" * 64,
        durationSec=600,
        sampleRate=44100,
        channels=2,
    )
    project.notes = [_note(piano, 60, 0, 0.5)]

    measures = build_musicxml(project).getroot().findall("part/measure")

    assert len(measures) == 1


def test_voice_count_is_limited_to_each_measure() -> None:
    project = create_project("voices by measure", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [
        _note(piano, 60, 0, 1.5),
        _note(piano, 67, 0.5, 1),
        _note(piano, 64, 2, 2.5),
    ]

    measures = build_musicxml(project).getroot().findall("part/measure")

    assert len(measures) == 2
    assert len(measures[0].findall("backup")) == 2
    assert len(measures[1].findall("backup")) == 1


def test_empty_measure_uses_one_complete_measure_rest() -> None:
    project = create_project("measure rest", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [
        _note(piano, 60, 0, 0.5),
        _note(piano, 64, 4, 4.5),
    ]

    measures = build_musicxml(project).getroot().findall("part/measure")
    rests = measures[1].findall("note/rest")

    assert len(rests) == 2
    assert all(rest.attrib["measure"] == "yes" for rest in rests)


def test_score_metadata_key_pickup_grand_staff_and_chords() -> None:
    project = create_project("score settings", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.5
    project.score.composer = "Composer"
    project.score.arranger = "Arranger"
    project.score.copyright = "Copyright"
    project.score.key_fifths = -2
    project.score.key_mode = "minor"
    project.score.pickup_ticks = 480
    project.score.chords = [
        ScoreChord(startSec=0, endSec=0.5, label="Bbmaj7"),
    ]
    project.notes = [
        _note(piano, 48, 0, 0.5),
        _note(piano, 72, 0.5, 1),
    ]

    root = build_musicxml(project).getroot()
    measures = root.findall("part/measure")

    assert root.findtext("identification/creator[@type='composer']") == "Composer"
    assert root.findtext("identification/creator[@type='arranger']") == "Arranger"
    assert root.findtext("identification/rights") == "Copyright"
    assert measures[0].attrib == {"number": "0", "implicit": "yes"}
    assert measures[0].findtext("attributes/key/fifths") == "-2"
    assert measures[0].findtext("attributes/key/mode") == "minor"
    assert measures[0].findtext("attributes/staves") == "2"
    assert measures[0].findtext("attributes/clef[@number='2']/sign") == "F"
    assert measures[0].findtext("harmony/root/root-step") == "B"
    assert measures[0].findtext("harmony/root/root-alter") == "-1"
    assert measures[0].findtext("harmony/kind") == "major-seventh"
    assert measures[0].find("note[staff='2']") is not None


def test_chord_symbols_use_standard_kinds_and_slash_bass() -> None:
    project = create_project("chords", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.score.chords = [
        ScoreChord(startSec=0, endSec=0.5, label="C#m7/G#"),
    ]
    project.notes = [_note(piano, 60, 0, 0.5)]

    harmony = build_musicxml(project).getroot().find("part/measure/harmony")

    assert harmony is not None
    assert harmony.findtext("root/root-step") == "C"
    assert harmony.findtext("root/root-alter") == "1"
    assert harmony.findtext("kind") == "minor-seventh"
    assert harmony.find("kind").attrib["text"] == "m7"
    assert harmony.findtext("bass/bass-step") == "G"
    assert harmony.findtext("bass/bass-alter") == "1"


def test_part_clef_and_written_pitch_transposition_are_configurable() -> None:
    project = create_project("transposed part", PRESET_BY_KEY["string-quartet"])
    violin = project.tracks[0]
    project.score.track_settings[str(violin.id)] = ScoreTrackSettings(
        clef="bass",
        transpositionSemitones=2,
    )
    project.notes = [_note(violin, 60, 0, 0.5)]

    measure = build_musicxml(project).getroot().find("part/measure")

    assert measure is not None
    assert measure.findtext("attributes/clef/sign") == "F"
    assert measure.findtext("attributes/transpose/chromatic") == "-2"
    assert measure.findtext("note/pitch/step") == "D"


@pytest.mark.parametrize(
    ("numerator", "denominator", "expected_ticks"),
    [(3, 4, 1440), (6, 8, 1440)],
)
def test_each_voice_fills_complete_measures_for_supported_time_signatures(
    numerator: int,
    denominator: int,
    expected_ticks: int,
) -> None:
    project = create_project("time signatures", PRESET_BY_KEY["string-quartet"])
    project.tempo.time_signature.numerator = numerator
    project.tempo.time_signature.denominator = denominator
    violin = project.tracks[0]
    project.notes = [_note(violin, 67, 0.25, 1.75)]

    measures = build_musicxml(project).getroot().findall("part/measure")

    assert len(measures) == 2
    for measure in measures:
        durations: dict[str, int] = {}
        for note in measure.findall("note"):
            if note.find("chord") is not None:
                continue
            voice = note.findtext("voice") or "1"
            durations[voice] = durations.get(voice, 0) + int(
                note.findtext("duration") or "0"
            )
        assert set(durations.values()) == {expected_ticks}


def test_export_requires_musicxml_extension_and_writes_parseable_xml(
    tmp_path,
) -> None:
    project = create_project("file", PRESET_BY_KEY["string-quartet"])
    output = tmp_path / "score.musicxml"

    export_musicxml(project, output)

    assert ET.parse(output).getroot().attrib["version"] == "4.0"
    assert "<!DOCTYPE score-partwise" in output.read_text(encoding="utf-8")
    with pytest.raises(ValueError, match=r"\.musicxml"):
        export_musicxml(project, tmp_path / "score.xml")


def test_export_quantizes_notes_to_project_resolution(tmp_path) -> None:
    project = create_project("MusicXML quantize", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.tempo.beat_offset_sec = 0.1
    project.tempo.quantize_grid = "1/4"
    project.notes = [_note(piano, 60, 0.36, 0.86)]
    output = tmp_path / "quantized.musicxml"

    export_musicxml(project, output)

    measure = ET.parse(output).getroot().find("part/measure")
    assert measure is not None
    first_rest = measure.find("note")
    assert first_rest is not None
    assert first_rest.find("rest") is not None
    assert first_rest.findtext("duration") == "480"
    pitched_note = next(
        note for note in measure.findall("note") if note.find("pitch") is not None
    )
    assert pitched_note.findtext("duration") == "480"
