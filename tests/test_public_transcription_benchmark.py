from scripts.run_public_transcription_benchmark import (
    CONDITION_DIRECT,
    _aggregate_condition,
    _condition_result,
    _separated_condition_arguments,
)
from scripts.compare_muscriptor_variants import ResultNote


def _score(matches: int, reference: int, precision: float, f1: float) -> dict:
    return {
        "referenceNotes": reference,
        "matches": matches,
        "precision": precision,
        "recall": matches / reference,
        "f1": f1,
        "timing": {
            "medianPredictionErrorMs": 10.0,
            "p95AbsoluteErrorMs": 30.0,
        },
    }


def test_condition_result_adds_timing_and_mismatch_score() -> None:
    result = {
        "score": _score(2, 2, 1.0, 1.0),
        "scoresByOnsetToleranceMs": {
            "50": _score(1, 2, 0.5, 0.5),
            "120": _score(2, 2, 1.0, 1.0),
        },
        "noteCount": 2,
        "crossInstrumentDuplicates": {"groups": 0},
        "notes": [
            {
                "instrument": "acoustic_piano",
                "pitch": 60,
                "startSec": 1.0,
                "endSec": 1.5,
            },
            {
                "instrument": "acoustic_piano",
                "pitch": 62,
                "startSec": 2.06,
                "endSec": 2.5,
            },
        ],
    }
    reference = [
        ResultNote("acoustic_piano", 60, 1.0, 1.5),
        ResultNote("acoustic_piano", 62, 2.0, 2.5),
    ]

    condition = _condition_result(
        result,
        reference,
    )

    assert condition["timingAndMismatchScore"] == {
        "matches": 2,
        "falsePositiveNotes": 0,
        "falseNegativeNotes": 0,
        "falsePositiveRate": 0.0,
        "falseNegativeRate": 0.0,
        "mismatchRate": 0.0,
        "timingCredit": 1.0,
        "onsetTimingScore": 0.5,
        "score": 0.5,
        "onsetToleranceMs": 120.0,
        "fullTimingPenaltyMs": 50.0,
    }


def test_aggregate_condition_uses_micro_counts_and_macro_f1() -> None:
    cases = [
        {
            "conditions": {
                CONDITION_DIRECT: {
                    "referenceNotes": 10,
                    "predictedNotes": 8,
                    "matches": 6,
                    "precision": 0.75,
                    "recall": 0.6,
                    "f1": 0.6667,
                    "score50Ms": {
                        "matches": 5,
                        "precision": 0.625,
                        "recall": 0.5,
                        "f1": 0.5556,
                    },
                    "medianPredictionErrorMs": 5.0,
                    "p95AbsoluteErrorMs": 25.0,
                    "crossInstrumentDuplicateGroups": 2,
                }
            }
        },
        {
            "conditions": {
                CONDITION_DIRECT: {
                    "referenceNotes": 20,
                    "predictedNotes": 12,
                    "matches": 9,
                    "precision": 0.75,
                    "recall": 0.45,
                    "f1": 0.5625,
                    "score50Ms": {
                        "matches": 7,
                        "precision": 0.5833,
                        "recall": 0.35,
                        "f1": 0.4375,
                    },
                    "medianPredictionErrorMs": 15.0,
                    "p95AbsoluteErrorMs": 35.0,
                    "crossInstrumentDuplicateGroups": 3,
                }
            }
        },
    ]

    aggregate = _aggregate_condition(cases, CONDITION_DIRECT)

    assert aggregate["microPrecision"] == 0.75
    assert aggregate["microRecall"] == 0.5
    assert aggregate["microF1"] == 0.6
    assert aggregate["falsePositiveNotes"] == 5
    assert aggregate["falseNegativeNotes"] == 15
    assert aggregate["macroF1"] == 0.6146
    assert aggregate["score50Ms"] == {
        "matches": 12,
        "falsePositiveNotes": 8,
        "falseNegativeNotes": 18,
        "microPrecision": 0.6,
        "microRecall": 0.4,
        "microF1": 0.48,
        "macroF1": 0.4965,
    }
    assert aggregate["medianOfTrackMedianErrorMs"] == 10.0
    assert aggregate["crossInstrumentDuplicateGroups"] == 5


def test_guided_condition_uses_current_post_transcription_filters() -> None:
    unguided = _separated_condition_arguments(
        drum_onset_guide=False,
        timing_guide_note_filter=False,
    )
    guided_without_note_filter = _separated_condition_arguments(
        drum_onset_guide=True,
        timing_guide_note_filter=False,
    )
    guided = _separated_condition_arguments(
        drum_onset_guide=True,
        timing_guide_note_filter=True,
    )

    assert "--guide-instrument-rejection" in unguided
    assert "--no-drum-onset-guide" in unguided
    assert "--no-timing-guide-note-filter" in unguided
    assert "--drum-onset-guide" in guided_without_note_filter
    assert "--no-timing-guide-note-filter" in guided_without_note_filter
    assert "--drum-onset-guide" in guided
    assert "--timing-guide-note-filter" in guided
