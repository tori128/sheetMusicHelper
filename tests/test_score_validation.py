from earcopy_service.models import Note
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.score_validation import validate_score


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


def test_score_validation_reports_navigable_export_issues() -> None:
    project = create_project("validation", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    drums = project.tracks[-1]
    project.tempo.beat_offset_sec = 0.5
    project.notes = [
        _note(piano, 60, 0.25, 0.75),
        _note(piano, 60, 0.5, 1.0),
        _note(drums, 10, 1.0, 1.1),
    ]

    result = validate_score(project)

    assert result.error_count == 2
    assert result.warning_count >= 1
    codes = {issue.code for issue in result.issues}
    assert {"before_score_origin", "same_pitch_overlap"} <= codes
    assert "unsupported_drum_pitch" not in codes
    overlap = next(issue for issue in result.issues if issue.code == "same_pitch_overlap")
    assert overlap.track_id == str(piano.id)
    assert len(overlap.note_ids) == 2
    assert overlap.measure_number == 1


def test_score_validation_groups_off_grid_notes_by_track_and_measure() -> None:
    project = create_project("off-grid", PRESET_BY_KEY["general-band"])
    piano = project.tracks[0]
    project.notes = [
        _note(piano, 60, 0.01, 0.26),
        _note(piano, 64, 0.51, 0.76),
        _note(piano, 67, 2.01, 2.26),
    ]

    result = validate_score(project)

    off_grid = [issue for issue in result.issues if issue.code == "off_grid"]
    assert len(off_grid) == 2
    assert len(off_grid[0].note_ids) == 2
    assert "2音" in off_grid[0].message


def test_drum_pitch_omitted_by_musicxml_export_does_not_block_export() -> None:
    project = create_project("drum export", PRESET_BY_KEY["general-band"])
    drums = project.tracks[-1]
    project.notes = [
        _note(drums, 36, 0.0, 0.02),
        _note(drums, 82, 0.5, 0.52),
    ]

    result = validate_score(project)

    assert result.error_count == 0
    assert "unsupported_drum_pitch" not in {
        issue.code for issue in result.issues
    }
