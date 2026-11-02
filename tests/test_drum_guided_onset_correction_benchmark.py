from scripts.compare_drum_guided_onset_correction import correct_onsets
from scripts.compare_muscriptor_variants import ResultNote


def _note(
    instrument: str,
    pitch: int,
    start_sec: float,
    end_sec: float,
) -> ResultNote:
    return ResultNote(instrument, pitch, start_sec, end_sec)


def test_correct_onsets_preserves_pitch_instrument_and_duration() -> None:
    drumless = [_note("acoustic_piano", 60, 1.0, 1.75)]
    guided = [_note("electric_piano", 60, 1.08, 1.2)]

    corrected, statistics = correct_onsets(drumless, guided, 0.1)

    assert corrected == [_note("acoustic_piano", 60, 1.08, 1.83)]
    assert statistics["correctedNotes"] == 1
    assert statistics["correctedByInput"] == {"piano": 1}


def test_correct_onsets_does_not_match_different_inputs_or_pitches() -> None:
    drumless = [
        _note("synth_lead", 60, 1.0, 1.5),
        _note("acoustic_piano", 62, 2.0, 2.5),
    ]
    guided = [
        _note("acoustic_piano", 60, 1.02, 1.5),
        _note("electric_piano", 61, 2.02, 2.5),
    ]

    corrected, statistics = correct_onsets(drumless, guided, 0.1)

    assert corrected == drumless
    assert statistics["correctedNotes"] == 0


def test_correct_onsets_uses_ordered_minimum_difference_matches() -> None:
    drumless = [
        _note("acoustic_bass", 40, 1.0, 1.4),
        _note("acoustic_bass", 40, 2.0, 2.4),
    ]
    guided = [
        _note("electric_bass", 40, 1.02, 1.2),
        _note("electric_bass", 40, 1.5, 1.7),
        _note("electric_bass", 40, 2.02, 2.2),
    ]

    corrected, statistics = correct_onsets(drumless, guided, 0.6)

    assert [note.start_sec for note in corrected] == [1.02, 2.02]
    assert [round(note.end_sec - note.start_sec, 6) for note in corrected] == [
        0.4,
        0.4,
    ]
    assert statistics["correctedNotes"] == 2


def test_correct_onsets_does_not_change_drum_notes() -> None:
    drumless = [_note("drums", 36, 1.0, 1.01)]
    guided = [_note("drums", 36, 1.08, 1.09)]

    corrected, statistics = correct_onsets(drumless, guided, 0.1)

    assert corrected == drumless
    assert statistics["correctedNotes"] == 0
