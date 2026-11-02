from scripts.compare_muscriptor_variants import ResultNote
from scripts.run_routing_policy_benchmark import (
    _comparison,
    _notes,
    _scored_condition,
)


def _condition(f1: float, matches: int) -> dict:
    return {
        "referenceNotes": 20,
        "predictedNotes": 20,
        "matches": matches,
        "precision": matches / 20,
        "recall": matches / 20,
        "f1": f1,
        "score50Ms": {
            "matches": matches,
            "precision": matches / 20,
            "recall": matches / 20,
            "f1": f1,
        },
        "medianPredictionErrorMs": 0.0,
        "p95AbsoluteErrorMs": 0.0,
        "crossInstrumentDuplicateGroups": 0,
    }


def test_note_payload_round_trips_and_scores_instruments() -> None:
    rows = [
        {
            "instrument": "electric_bass",
            "pitch": 40,
            "startSec": 1.01,
            "endSec": 1.5,
        }
    ]
    predicted = _notes(rows)
    reference = [ResultNote("electric_bass", 40, 1.0, 1.5)]

    assert predicted == [ResultNote("electric_bass", 40, 1.01, 1.5)]
    assert _scored_condition(predicted, reference)["score50Ms"]["f1"] == 1.0


def test_policy_comparison_reports_paired_outcomes() -> None:
    cases = [
        {
            "trackId": "a",
            "conditions": {
                "baseline": _condition(0.5, 10),
                "candidate": _condition(0.55, 11),
            },
        },
        {
            "trackId": "b",
            "conditions": {
                "baseline": _condition(0.5, 10),
                "candidate": _condition(0.5, 10),
            },
        },
    ]

    comparison = _comparison(cases, "candidate", "baseline", "conditions")

    assert comparison["classification"] == "improved"
    assert comparison["trackWins"] == 1
    assert comparison["trackTies"] == 1
    assert comparison["trackLosses"] == 0
