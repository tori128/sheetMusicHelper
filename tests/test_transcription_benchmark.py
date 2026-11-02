import mido
import numpy as np
import pytest
import soundfile as sf

from scripts.compare_muscriptor_variants import (
    ResultNote,
    _aggregate_timing_and_mismatch,
    _crop_reference_notes,
    _notation_score,
    _reference_notes,
    _reference_score,
    _timing_and_mismatch_score,
)
from scripts.score_transcription_job import (
    _continuous_same_pitch_chains,
    _cross_instrument_duplicates,
    _note_health,
    _tracks_for_instruments,
    _write_audio_segment,
)
from scripts.run_timing_guide_gain_benchmark import (
    PRODUCT_GAINS,
    PRODUCT_VARIANT_ID,
    Variant,
    _micro_aggregate,
)
from scripts.run_bass_timing_guide_cutoff_benchmark import (
    _attack_to_bass_ratio,
)


def _note(start_sec: float) -> ResultNote:
    return ResultNote(
        instrument="acoustic_piano",
        pitch=60,
        start_sec=start_sec,
        end_sec=start_sec + 0.25,
    )


def test_bass_guide_cutoff_constraint_rejects_c_sharp_3() -> None:
    assert _attack_to_bass_ratio(180.0) < 8.0
    assert _attack_to_bass_ratio(250.0) > 8.0


def test_reference_score_reports_small_onset_error() -> None:
    score = _reference_score([_note(1.02)], [_note(1.0)])

    assert score["matches"] == 1
    assert score["timing"] == {
        "matchedNotes": 1,
        "medianPredictionErrorMs": 20.0,
        "p95AbsoluteErrorMs": 20.0,
        "bestGlobalCorrectionMs": -20,
        "matchesAtBestCorrection": 1,
    }


def test_reference_score_detects_half_beat_systematic_shift() -> None:
    predicted = [_note(1.25), _note(2.25)]
    reference = [_note(1.0), _note(2.0)]

    score = _reference_score(predicted, reference)

    assert score["matches"] == 0
    assert score["timing"]["bestGlobalCorrectionMs"] == -250
    assert score["timing"]["matchesAtBestCorrection"] == 2


def test_reference_score_penalizes_extra_and_missing_notes() -> None:
    predicted = [_note(1.0), _note(4.0)]
    reference = [_note(1.0), _note(2.0)]

    score = _reference_score(predicted, reference)

    assert score["matches"] == 1
    assert score["falsePositiveNotes"] == 1
    assert score["falseNegativeNotes"] == 1
    assert score["precision"] == 0.5
    assert score["recall"] == 0.5
    assert score["f1"] == 0.5


def test_timing_and_mismatch_score_penalizes_onset_error_continuously() -> None:
    exact = _timing_and_mismatch_score([_note(1.0)], [_note(1.0)])
    delayed = _timing_and_mismatch_score([_note(1.025)], [_note(1.0)])

    assert exact["mismatchRate"] == 0.0
    assert exact["onsetTimingScore"] == 1.0
    assert exact["score"] == 1.0
    assert delayed["mismatchRate"] == 0.0
    assert delayed["onsetTimingScore"] == 0.5
    assert delayed["score"] == 0.5


def test_timing_and_mismatch_score_penalizes_both_mismatch_types() -> None:
    predicted = [_note(1.0), _note(4.0)]
    reference = [_note(1.0), _note(2.0)]

    score = _timing_and_mismatch_score(predicted, reference)

    assert score["matches"] == 1
    assert score["falsePositiveNotes"] == 1
    assert score["falseNegativeNotes"] == 1
    assert score["falsePositiveRate"] == 0.5
    assert score["falseNegativeRate"] == 0.5
    assert score["mismatchRate"] == 0.5
    assert score["onsetTimingScore"] == 1.0
    assert score["score"] == 0.5


def test_timing_and_mismatch_aggregate_uses_micro_counts() -> None:
    conditions = [
        {
            "referenceNotes": 2,
            "predictedNotes": 2,
            "timingAndMismatchScore": {
                "matches": 1,
                "timingCredit": 1.0,
            },
        },
        {
            "referenceNotes": 3,
            "predictedNotes": 2,
            "timingAndMismatchScore": {
                "matches": 2,
                "timingCredit": 1.5,
            },
        },
    ]

    score = _aggregate_timing_and_mismatch(conditions)

    assert score == {
        "matches": 3,
        "falsePositiveNotes": 1,
        "falseNegativeNotes": 2,
        "falsePositiveRate": 0.25,
        "falseNegativeRate": 0.4,
        "mismatchRate": 0.3333,
        "timingCredit": 2.5,
        "onsetTimingScore": 0.8333,
        "score": 0.5556,
        "onsetToleranceMs": 120,
        "fullTimingPenaltyMs": 50,
    }


def test_timing_guide_micro_score_reports_both_mismatch_types() -> None:
    condition = {
        "referenceNotes": 3,
        "predictedNotes": 2,
        "score20Ms": {"matches": 1},
        "score50Ms": {"matches": 1},
        "score120Ms": {"matches": 1},
        "timingAndMismatchScore": {
            "matches": 1,
            "timingCredit": 0.75,
        },
    }

    aggregate = _micro_aggregate([condition])

    assert aggregate["score20Ms"] == {
        "matches": 1,
        "falsePositiveNotes": 1,
        "falseNegativeNotes": 2,
        "precision": 0.5,
        "recall": 0.3333,
        "microF1": 0.4,
    }
    assert aggregate["timingAndMismatchScore"]["score"] == 0.3


def test_gain_variants_change_only_the_evaluated_component() -> None:
    baseline = Variant("other", 0.2)
    guitar_30 = Variant("guitar", 0.3)

    assert baseline.gains == PRODUCT_GAINS
    assert baseline.raw_result_id == PRODUCT_VARIANT_ID
    assert guitar_30.gains == {
        "bass": 0.2,
        "piano": 0.2,
        "guitar": 0.3,
        "vocals": 0.2,
        "other": 0.2,
    }
    assert guitar_30.raw_result_id == "guitar-g30"


def test_notation_score_uses_a_50_ms_onset_tolerance() -> None:
    reference = [_note(1.0)]

    assert _notation_score([_note(1.049)], reference)["matches"] == 1
    assert _notation_score([_note(1.051)], reference)["matches"] == 0


def test_notation_score_checks_offsets_separately() -> None:
    reference = [_note(1.0)]
    predicted = [ResultNote("acoustic_piano", 60, 1.01, 1.8)]

    onset_score = _notation_score(predicted, reference)
    offset_score = _notation_score(
        predicted,
        reference,
        require_offset=True,
    )

    assert onset_score["matches"] == 1
    assert offset_score["matches"] == 0


def test_notation_score_finds_a_maximum_one_to_one_matching() -> None:
    reference = [_note(0.0), _note(0.05)]
    predicted = [_note(0.04), _note(0.1)]

    score = _notation_score(predicted, reference)

    assert score["matches"] == 2
    assert score["f1"] == 1.0


def test_crop_reference_notes_rebases_and_clips_the_selected_interval() -> None:
    notes = [
        ResultNote("acoustic_piano", 60, 9.9, 10.2),
        ResultNote("acoustic_piano", 62, 10.5, 12.5),
        ResultNote("acoustic_piano", 64, 12.0, 12.2),
    ]

    cropped = _crop_reference_notes(notes, start_sec=10.0, duration_sec=2.0)

    assert cropped == [ResultNote("acoustic_piano", 62, 0.5, 2.0)]


def test_reference_notes_honor_tempo_and_can_include_unmapped_programs(
    tmp_path,
) -> None:
    path = tmp_path / "unmapped.mid"
    midi = mido.MidiFile(type=1, ticks_per_beat=480)
    tempo_track = mido.MidiTrack()
    tempo_track.append(
        mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(60), time=0)
    )
    note_track = mido.MidiTrack()
    note_track.extend(
        [
            mido.Message("program_change", program=99, channel=0, time=0),
            mido.Message("note_on", note=60, velocity=100, channel=0, time=480),
            mido.Message("note_off", note=60, velocity=0, channel=0, time=480),
        ]
    )
    midi.tracks.extend([tempo_track, note_track])
    midi.save(path)

    assert _reference_notes(path) == []
    reference = _reference_notes(path, include_unmapped=True)

    assert len(reference) == 1
    assert reference[0].instrument == "unmapped"
    assert reference[0].start_sec == 1.0
    assert reference[0].end_sec == 2.0
    score = _reference_score(
        [_note(1.0)],
        reference,
        match_instruments=False,
    )
    assert score["matches"] == 1


def test_reference_notes_map_supported_gm_programs_and_drum_channel(
    tmp_path,
) -> None:
    path = tmp_path / "mapped.mid"
    midi = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    track.extend(
        [
            mido.Message("program_change", program=33, channel=0, time=0),
            mido.Message("note_on", note=40, velocity=100, channel=0, time=0),
            mido.Message("note_off", note=40, velocity=0, channel=0, time=120),
            mido.Message("note_on", note=36, velocity=100, channel=9, time=0),
            mido.Message("note_off", note=36, velocity=0, channel=9, time=120),
        ]
    )
    midi.tracks.append(track)
    midi.save(path)

    reference = _reference_notes(path)

    assert [note.instrument for note in reference] == [
        "electric_bass",
        "drums",
    ]


def test_note_health_reports_invalid_ranges_and_continuous_chains() -> None:
    notes = [
        ResultNote("acoustic_piano", 60, float(index), float(index + 1))
        for index in range(12)
    ]
    notes.extend(
        (
            ResultNote("acoustic_piano", 62, 1.0, 1.01),
            ResultNote("acoustic_piano", 64, 2.0, 13.0),
            ResultNote("acoustic_piano", 65, 15.0, 16.0),
        )
    )

    health = _note_health(notes, duration_sec=15.5)

    assert health["pitchedNotesAtOrBelow10Ms"] == 1
    assert health["drumNotesAtOrBelow10Ms"] == 0
    assert health["notesOver10Sec"] == 1
    assert health["notesEndingPastAudio"] == 1
    assert health["continuousSamePitchChainsOver10Sec"] == 1
    assert _continuous_same_pitch_chains(notes) == 1


def test_health_separates_short_drum_hits_from_short_pitched_notes() -> None:
    notes = [
        ResultNote("drums", 36, 1.0, 1.01),
        ResultNote("acoustic_piano", 60, 2.0, 2.01),
    ]

    health = _note_health(notes, duration_sec=3.0)

    assert health["pitchedNotesAtOrBelow10Ms"] == 1
    assert health["drumNotesAtOrBelow10Ms"] == 1


def test_cross_instrument_duplicates_ignore_drum_note_numbers() -> None:
    notes = [
        ResultNote("drums", 60, 1.0, 1.01),
        ResultNote("acoustic_piano", 60, 1.0, 1.5),
        ResultNote("string_ensemble", 60, 1.01, 1.5),
    ]

    duplicates = _cross_instrument_duplicates(notes)

    assert duplicates == {
        "groups": 1,
        "notes": 2,
        "instrumentSets": {"acoustic_piano+string_ensemble": 1},
    }


def test_write_audio_segment_rebases_selected_interval(tmp_path) -> None:
    source = tmp_path / "source.wav"
    destination = tmp_path / "segment.wav"
    sample_rate = 8_000
    audio = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
    sf.write(source, audio, sample_rate, subtype="FLOAT")

    duration = _write_audio_segment(
        source,
        destination,
        start_sec=0.5,
        duration_sec=0.75,
    )

    selected, selected_rate = sf.read(destination, dtype="float32")
    assert selected_rate == sample_rate
    assert duration == pytest.approx(0.75)
    assert len(selected) == sample_rate * 3 // 4
    assert selected[0] == pytest.approx(audio[sample_rate // 2])


def test_benchmark_tracks_support_non_builtin_preset_instruments() -> None:
    tracks = _tracks_for_instruments(
        ["acoustic_piano", "synth_pad", "drums"]
    )

    assert [track.instrument_id for track in tracks] == [
        "acoustic_piano",
        "synth_pad",
        "drums",
    ]
    assert [track.midi_channel for track in tracks] == [1, 2, 10]
