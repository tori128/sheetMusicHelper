from uuid import UUID

import pytest

from earcopy_service.models import Note
from scripts.compare_muscriptor_variants import ResultNote
from scripts.evaluate_application_onset_correction import aggregate, compare_records


def _note(identifier, pitch, start):
    return Note(
        id=UUID(int=identifier), sourceInstrumentId='acoustic_piano',
        trackId=UUID(int=100), pitch=pitch, rawStartSec=start,
        rawEndSec=start + 0.4, startSec=start, endSec=start + 0.4,
    ).model_dump(by_alias=True, mode='json')


def _record(notes):
    return {'notes': notes, 'seconds': 1.0, 'corrections': [], 'partials': [], 'stems': []}


def test_paired_timing_uses_same_note_ids_despite_reordering_and_removal():
    reference = [ResultNote(instrument='acoustic_piano', pitch=pitch,
                            start_sec=start, end_sec=start + 0.4)
                 for pitch, start in [(60, 1.0), (62, 2.0), (65, 3.0)]]
    before = _record([_note(1, 60, 1.03), _note(2, 62, 2.03), _note(3, 65, 3.03)])
    after = _record([_note(2, 62, 2.02), _note(1, 60, 1.01)])
    result, before_errors, after_errors = compare_records(before, after, reference)

    assert result['pairedMatches120Ms'] == 2
    assert result['beforeMaeMs'] == pytest.approx(30.0)
    assert result['afterMaeMs'] == pytest.approx(15.0)
    assert before_errors == pytest.approx([0.03, 0.03])
    assert after_errors == pytest.approx([0.01, 0.02])
    assert result['before']['50']['f1'] == 1.0
    assert result['after']['50']['f1'] == 0.8


def test_aggregate_weights_note_errors_and_f1_by_note_counts():
    reference = [ResultNote(instrument='acoustic_piano', pitch=60,
                            start_sec=1.0, end_sec=1.4)]
    row, before_errors, after_errors = compare_records(
        _record([_note(1, 60, 1.03)]), _record([_note(1, 60, 1.01)]), reference,
    )
    reference = [ResultNote(instrument='acoustic_piano', pitch=60 + index,
                            start_sec=2.0 + index, end_sec=2.4 + index)
                 for index in range(3)]
    other, other_before, other_after = compare_records(
        _record([_note(index + 2, 60 + index, 2.05 + index) for index in range(3)]),
        _record([_note(index + 2, 60 + index, 2.005 + index) for index in range(3)]),
        reference,
    )
    summary = aggregate([row, other], before_errors + other_before, after_errors + other_after)
    assert summary['pairedMatches120Ms'] == 4
    assert summary['beforeMaeMs'] == pytest.approx(45.0)
    assert summary['afterMaeMs'] == pytest.approx(6.25)
    assert summary['beforeF1']['20'] == 0.0
    assert summary['afterF1']['20'] == 1.0
