from xml.etree import ElementTree as ET

import pytest

from earcopy_service.models import Note, SourceAudio
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


def test_export_quantizes_performance_timing_for_notation() -> None:
    project = create_project("quantized", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [_note(piano, 60, 0.03, 0.46)]

    note = build_musicxml(project).getroot().find("part/measure/note")

    assert note is not None
    assert note.findtext("duration") == "480"
    assert note.findtext("type") == "quarter"


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
    assert measures[0].find("backup") is not None
    assert measures[1].find("backup") is None


def test_empty_measure_uses_one_complete_measure_rest() -> None:
    project = create_project("measure rest", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [
        _note(piano, 60, 0, 0.5),
        _note(piano, 64, 4, 4.5),
    ]

    measures = build_musicxml(project).getroot().findall("part/measure")
    rests = measures[1].findall("note/rest")

    assert len(rests) == 1
    assert rests[0].attrib["measure"] == "yes"


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
