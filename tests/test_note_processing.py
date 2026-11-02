from uuid import UUID, uuid4

import numpy as np
import pytest
import soundfile as sf

import earcopy_service.note_processing as note_processing
from earcopy_service.models import Note
from earcopy_service.note_processing import (
    MAXIMUM_NOTE_DURATION_SEC,
    MINIMUM_NOTE_DURATION_SEC,
    NoteEndEvent,
    NoteEventAssembler,
    NoteStartEvent,
    detect_effective_audio_end,
    extend_missing_chunk_boundary_sustains,
    filter_notes_after_audio_tail,
    filter_pathological_note_chains,
    filter_timing_guide_notes,
    reassign_notes,
    trim_note_ends_without_pitch_activity,
)
from earcopy_service.presets import PRESET_BY_KEY, create_project


def test_note_events_are_joined_by_event_index() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})

    assert (
        assembler.feed(
            NoteStartEvent(
                event_index=7,
                instrument_id="acoustic_piano",
                pitch=64,
                start_sec=1.25,
            )
        )
        is None
    )
    note = assembler.feed(NoteEndEvent(event_index=7, end_sec=1.75))

    assert note is not None
    assert note.track_id == track.id
    assert note.pitch == 64
    assert assembler.pending_count == 0
    assert assembler.published_count == 1


def test_note_ids_are_reproducible_with_the_same_analysis_namespace() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]

    def assemble(namespace: str) -> UUID:
        assembler = NoteEventAssembler(
            {track.instrument_id: track.id},
            note_id_namespace=namespace,
        )
        assembler.feed(
            NoteStartEvent(
                event_index=7,
                instrument_id=track.instrument_id,
                pitch=64,
                start_sec=1.25,
            )
        )
        note = assembler.feed(NoteEndEvent(event_index=7, end_sec=1.75))
        assert note is not None
        return note.id

    first = assemble("same-audio-and-settings")
    second = assemble("same-audio-and-settings")
    different = assemble("different-settings")

    assert isinstance(first, UUID)
    assert first == second
    assert first != different


def test_timing_guide_filter_keeps_only_pitches_supported_nearby() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]

    def note(pitch: int, start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=pitch,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    unsupported_short = note(60, 1.0, 1.1)
    supported_short = note(62, 2.0, 2.1)
    unsupported_long = note(64, 6.0, 6.5)
    unmodified_support = note(62, 2.05, 2.3)

    result = filter_timing_guide_notes(
        [unsupported_short, supported_short, unsupported_long],
        [unmodified_support],
    )

    assert result.notes == [supported_short]
    assert result.discarded_count == 2


def test_timing_guide_filter_keeps_a_shifted_overlapping_note() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    guided = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=1.2,
        startSec=1.0,
        endSec=1.2,
    )
    unmodified = guided.model_copy(
        update={"raw_start_sec": 1.051, "start_sec": 1.051}
    )

    result = filter_timing_guide_notes([guided], [unmodified])

    assert result.notes == [guided]
    assert result.discarded_count == 0


def test_timing_guide_filter_keeps_a_shifted_nonoverlapping_note() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    guided = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=1.2,
        startSec=1.0,
        endSec=1.2,
    )
    unmodified = guided.model_copy(
        update={
            "raw_start_sec": 1.25,
            "raw_end_sec": 1.45,
            "start_sec": 1.25,
            "end_sec": 1.45,
        }
    )

    result = filter_timing_guide_notes([guided], [unmodified])

    assert result.notes == [guided]
    assert result.discarded_count == 0


def test_timing_guide_filter_discards_same_pitch_outside_evidence_window() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    guided = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=1.2,
        startSec=1.0,
        endSec=1.2,
    )
    unmodified = guided.model_copy(
        update={
            "raw_start_sec": 3.701,
            "raw_end_sec": 3.9,
            "start_sec": 3.701,
            "end_sec": 3.9,
        }
    )

    result = filter_timing_guide_notes([guided], [unmodified])

    assert result.notes == []
    assert result.discarded_count == 1


def test_timing_guide_filter_merges_split_notes_covered_by_one_reference() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]

    def note(start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=60,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    guided = [
        note(1.0, 1.15),
        note(1.17, 1.32).model_copy(update={"velocity": 120}),
        note(1.34, 1.5),
    ]
    result = filter_timing_guide_notes(guided, [note(1.0, 1.5)])

    assert result.notes == [
        guided[0].model_copy(
            update={"raw_end_sec": 1.5, "end_sec": 1.5}
        )
    ]
    assert result.discarded_count == 0
    assert result.merged_count == 2


def test_timing_guide_filter_preserves_split_supported_by_reference_notes() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]

    def note(start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=60,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    guided = [note(1.0, 1.2), note(1.22, 1.5)]
    result = filter_timing_guide_notes(
        guided,
        [note(1.0, 1.2), note(1.22, 1.5)],
    )

    assert result.notes == guided
    assert result.discarded_count == 0
    assert result.merged_count == 0


def test_timing_guide_filter_preserves_notes_separated_by_more_than_20_ms() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]

    def note(start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=60,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    guided = [note(1.0, 1.2), note(1.221, 1.5)]
    result = filter_timing_guide_notes(guided, [note(1.0, 1.5)])

    assert result.notes == guided
    assert result.discarded_count == 0
    assert result.merged_count == 0


def test_timing_guide_filter_preserves_notes_overlapping_by_more_than_20_ms() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]

    def note(start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=60,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    guided = [note(1.0, 1.3), note(1.279, 1.5)]
    result = filter_timing_guide_notes(guided, [note(1.0, 1.5)])

    assert result.notes == guided
    assert result.discarded_count == 0
    assert result.merged_count == 0


def test_timing_guide_filter_preserves_onset_found_for_two_instruments() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    first_track, second_track = project.tracks[:2]

    def note(track, start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=60,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    guided = [
        note(first_track, 1.0, 1.2),
        note(first_track, 1.2, 1.5),
        note(second_track, 1.0, 1.2),
        note(second_track, 1.2, 1.5),
    ]
    result = filter_timing_guide_notes(
        guided,
        [note(first_track, 1.0, 1.5)],
    )

    assert result.notes == guided
    assert result.discarded_count == 0
    assert result.merged_count == 0


def test_timing_guide_filter_does_not_accept_a_nearby_different_pitch() -> None:
    project = create_project("timing guide", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    guided = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=72,
        rawStartSec=1.0,
        rawEndSec=1.2,
        startSec=1.0,
        endSec=1.2,
    )
    different_pitch = guided.model_copy(update={"pitch": 60})

    result = filter_timing_guide_notes([guided], [different_pitch])

    assert result.notes == []
    assert result.discarded_count == 1


def test_reject_candidate_instrument_is_discarded_once() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})

    assembler.feed(
        NoteStartEvent(
            event_index=8,
            instrument_id="drums",
            pitch=36,
            start_sec=1.0,
        )
    )
    note = assembler.feed(NoteEndEvent(event_index=8, end_sec=1.1))

    assert note is None
    assert assembler.discarded_count == 1
    assert assembler.rejected_instrument_count == 1
    assert assembler.pending_count == 0


@pytest.mark.parametrize("end_sec", [1.25, 1.0, 1.26])
def test_invalid_pitched_note_is_discarded(end_sec: float) -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )

    note = assembler.feed(NoteEndEvent(event_index=7, end_sec=end_sec))

    assert note is None
    assert assembler.published_count == 0
    assert assembler.discarded_count == 1
    assert assembler.pending_count == 0


def test_invalid_note_and_immediate_retrigger_are_discarded_together() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )
    assert assembler.feed(NoteEndEvent(event_index=7, end_sec=1.25)) is None
    assembler.feed(
        NoteStartEvent(
            event_index=8,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )

    assert assembler.feed(NoteEndEvent(event_index=8, end_sec=8.0)) is None
    assert assembler.discarded_count == 2
    assert assembler.pending_count == 0


def test_note_longer_than_muscriptor_limit_is_discarded() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )

    note = assembler.feed(
        NoteEndEvent(
            event_index=7,
            end_sec=1.25 + MAXIMUM_NOTE_DURATION_SEC + 0.01,
        )
    )

    assert note is None
    assert assembler.discarded_count == 1


def test_overlapping_same_pitch_chain_longer_than_limit_is_discarded() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    notes = [
        Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=64,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )
        for start, end in ((0.0, 6.0), (5.0, 11.0), (10.0, 15.0))
    ]
    touching = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=65,
        rawStartSec=0.0,
        rawEndSec=5.0,
        startSec=0.0,
        endSec=5.0,
    )
    retriggered = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=65,
        rawStartSec=5.0,
        rawEndSec=9.0,
        startSec=5.0,
        endSec=9.0,
    )

    result = filter_pathological_note_chains(notes + [touching, retriggered])

    assert result.notes == [touching, retriggered]
    assert result.discarded_count == 3
    assert result.discarded_chains == 1


@pytest.mark.parametrize("has_evidence", [False, True])
def test_long_touching_retrigger_chain_requires_audio_evidence(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    has_evidence: bool,
) -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[2]
    notes = [
        Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=36,
            rawStartSec=float(index),
            rawEndSec=float(index + 1),
            startSec=float(index),
            endSec=float(index + 1),
        )
        for index in range(12)
    ]
    evidence_path = tmp_path / "bass.wav"
    monkeypatch.setattr(
        note_processing,
        "_has_retrigger_evidence",
        lambda path, chain: path == evidence_path
        and chain == notes
        and has_evidence,
    )

    result = filter_pathological_note_chains(
        notes,
        {track.instrument_id: evidence_path},
    )

    assert result.notes == (notes if has_evidence else [])
    assert result.discarded_count == (0 if has_evidence else len(notes))
    assert result.discarded_chains == (0 if has_evidence else 1)


def test_notes_after_trailing_audio_are_discarded_and_crossing_note_is_clipped(
    tmp_path,
) -> None:
    sample_rate = 8_000
    audio_path = tmp_path / "stem.wav"
    audio = np.concatenate(
        (
            np.full(sample_rate, 0.1, dtype=np.float32),
            np.zeros(sample_rate * 2, dtype=np.float32),
        )
    )
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    notes = [
        Note(
            sourceInstrumentId=track.instrument_id,
            trackId=track.id,
            pitch=pitch,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )
        for pitch, start, end in (
            (60, 0.5, 0.9),
            (62, 0.8, 2.0),
            (64, 2.0, 2.2),
        )
    ]

    result = filter_notes_after_audio_tail(
        notes,
        {track.instrument_id: audio_path},
    )

    assert [note.pitch for note in result.notes] == [60, 62]
    assert result.notes[0].raw_end_sec == pytest.approx(0.9)
    assert result.notes[1].raw_end_sec == pytest.approx(1.5)
    assert result.notes[1].end_sec == pytest.approx(1.5)
    assert result.discarded_count == 1
    assert result.truncated_count == 1


def test_internal_silence_does_not_limit_effective_audio_end(tmp_path) -> None:
    sample_rate = 8_000
    audio_path = tmp_path / "stem.wav"
    audio = np.concatenate(
        (
            np.full(sample_rate // 2, 0.1, dtype=np.float32),
            np.zeros(sample_rate, dtype=np.float32),
            np.full(sample_rate // 2, 0.1, dtype=np.float32),
        )
    )
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")

    assert detect_effective_audio_end(audio_path) == pytest.approx(2.0)


def test_note_end_is_trimmed_after_its_pitch_becomes_inactive(tmp_path) -> None:
    sample_rate = 22_050
    audio_path = tmp_path / "released-note.wav"
    time = np.arange(sample_rate * 3, dtype=np.float32) / sample_rate
    audio = np.zeros_like(time)
    active = (time >= 0.25) & (time < 1.25)
    audio[active] = 0.2 * np.sin(2 * np.pi * 261.6256 * time[active])
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    note = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=0.25,
        rawEndSec=2.5,
        startSec=0.25,
        endSec=2.5,
    )

    result = trim_note_ends_without_pitch_activity(
        [note],
        {track.instrument_id: audio_path},
    )

    assert result.truncated_count == 1
    assert 1.2 <= result.notes[0].raw_end_sec <= 1.6
    assert result.notes[0].end_sec == result.notes[0].raw_end_sec


def test_note_end_is_preserved_while_its_pitch_remains_active(tmp_path) -> None:
    sample_rate = 22_050
    audio_path = tmp_path / "sustained-note.wav"
    time = np.arange(sample_rate * 3, dtype=np.float32) / sample_rate
    audio = 0.2 * np.sin(2 * np.pi * 261.6256 * time)
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    sustained = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=0.25,
        rawEndSec=2.5,
        startSec=0.25,
        endSec=2.5,
    )
    short = sustained.model_copy(
        update={
            "raw_end_sec": 0.75,
            "end_sec": 0.75,
        }
    )

    result = trim_note_ends_without_pitch_activity(
        [sustained, short],
        {track.instrument_id: audio_path},
    )

    assert result.notes == [sustained, short]
    assert result.truncated_count == 0


def test_missing_chunk_boundary_sustain_is_extended_from_pitch_activity(
    tmp_path,
) -> None:
    sample_rate = 22_050
    audio_path = tmp_path / "chunk-boundary-sustain.wav"
    time = np.arange(sample_rate * 8, dtype=np.float32) / sample_rate
    audio = 0.2 * np.sin(2 * np.pi * 261.6256 * time)
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    note = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=5.0,
        startSec=1.0,
        endSec=5.0,
    )

    result = extend_missing_chunk_boundary_sustains(
        [note],
        {track.instrument_id: audio_path},
        5.0,
    )

    assert result.extended_count == 1
    assert 7.8 <= result.notes[0].raw_end_sec <= 8.0
    assert result.notes[0].end_sec == result.notes[0].raw_end_sec


def test_existing_same_pitch_note_prevents_chunk_boundary_extension(
    tmp_path,
) -> None:
    sample_rate = 22_050
    audio_path = tmp_path / "chunk-boundary-retrigger.wav"
    time = np.arange(sample_rate * 8, dtype=np.float32) / sample_rate
    audio = 0.2 * np.sin(2 * np.pi * 261.6256 * time)
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    first = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=5.0,
        startSec=1.0,
        endSec=5.0,
    )
    second = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=5.05,
        rawEndSec=6.0,
        startSec=5.05,
        endSec=6.0,
    )

    result = extend_missing_chunk_boundary_sustains(
        [first, second],
        {track.instrument_id: audio_path},
        5.0,
    )

    assert result.notes == [first, second]
    assert result.extended_count == 0


def test_inactive_pitch_after_chunk_boundary_is_not_extended(tmp_path) -> None:
    sample_rate = 22_050
    audio_path = tmp_path / "inactive-after-chunk-boundary.wav"
    time = np.arange(sample_rate * 8, dtype=np.float32) / sample_rate
    audio = np.zeros_like(time)
    active = (time >= 1.0) & (time < 4.5)
    audio[active] = 0.2 * np.sin(2 * np.pi * 261.6256 * time[active])
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    note = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=5.0,
        startSec=1.0,
        endSec=5.0,
    )

    result = extend_missing_chunk_boundary_sustains(
        [note],
        {track.instrument_id: audio_path},
        5.0,
    )

    assert result.notes == [note]
    assert result.extended_count == 0


def test_chunk_boundary_extension_respects_maximum_note_duration(
    tmp_path,
) -> None:
    sample_rate = 22_050
    audio_path = tmp_path / "long-chunk-boundary-sustain.wav"
    time = np.arange(sample_rate * 15, dtype=np.float32) / sample_rate
    audio = 0.2 * np.sin(2 * np.pi * 261.6256 * time)
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    note = Note(
        sourceInstrumentId=track.instrument_id,
        trackId=track.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=5.0,
        startSec=1.0,
        endSec=5.0,
    )

    result = extend_missing_chunk_boundary_sustains(
        [note],
        {track.instrument_id: audio_path},
        5.0,
    )

    assert result.extended_count == 1
    assert result.notes[0].raw_end_sec == pytest.approx(11.0)


def test_quiet_stem_is_measured_relative_to_its_own_peak(tmp_path) -> None:
    sample_rate = 8_000
    audio_path = tmp_path / "quiet.wav"
    quiet_amplitude = 10 ** (-68 / 20)
    audio = np.concatenate(
        (
            np.full(sample_rate, quiet_amplitude, dtype=np.float32),
            np.zeros(sample_rate * 2, dtype=np.float32),
        )
    )
    sf.write(audio_path, audio, sample_rate, subtype="FLOAT")

    assert detect_effective_audio_end(audio_path) == pytest.approx(1.5)


def test_short_silent_stem_has_no_effective_audio(tmp_path) -> None:
    sample_rate = 8_000
    audio_path = tmp_path / "silent.wav"
    sf.write(
        audio_path,
        np.zeros(sample_rate // 2, dtype=np.float32),
        sample_rate,
        subtype="FLOAT",
    )

    assert detect_effective_audio_end(audio_path) == 0.0


def test_zero_duration_drum_hit_is_clamped_to_minimum_duration() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    drum_track = next(
        track for track in project.tracks if track.instrument_id == "drums"
    )
    assembler = NoteEventAssembler({drum_track.instrument_id: drum_track.id})
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id="drums",
            pitch=38,
            start_sec=1.25,
        )
    )

    note = assembler.feed(NoteEndEvent(event_index=7, end_sec=1.25))

    assert note is not None
    assert note.end_sec == pytest.approx(1.25 + MINIMUM_NOTE_DURATION_SEC)
    assert assembler.published_count == 1
    assert assembler.corrected_count == 1


def test_orphan_end_and_unfinished_start_are_discarded() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    track = project.tracks[0]
    assembler = NoteEventAssembler({track.instrument_id: track.id})

    assert assembler.feed(NoteEndEvent(event_index=99, end_sec=1.0)) is None
    assembler.feed(
        NoteStartEvent(
            event_index=7,
            instrument_id=track.instrument_id,
            pitch=64,
            start_sec=1.25,
        )
    )

    assert assembler.discard_pending() == 1
    assert assembler.pending_count == 0
    assert assembler.discarded_count == 2


def test_reassignment_moving_note_overwrites_existing_duplicate() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    source, target = project.tracks[0], project.tracks[1]
    existing = Note(
        sourceInstrumentId=target.instrument_id,
        trackId=target.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=1.4,
        startSec=1.0,
        endSec=1.4,
    )
    moved = Note(
        sourceInstrumentId=source.instrument_id,
        trackId=source.id,
        pitch=60,
        rawStartSec=1.0,
        rawEndSec=2.0,
        startSec=1.0,
        endSec=2.0,
    )

    result = reassign_notes([existing, moved], {moved.id}, target.id, bpm=120)

    assert len(result.notes) == 1
    assert result.notes[0].id == moved.id
    assert result.notes[0].track_id == target.id
    assert result.selected_note_ids == {moved.id}


def test_longest_selected_note_wins_when_selection_collides() -> None:
    project = create_project("test", PRESET_BY_KEY["general-band"])
    source, target = project.tracks[0], project.tracks[1]
    notes = [
        Note(
            sourceInstrumentId=source.instrument_id,
            trackId=source.id,
            pitch=62,
            rawStartSec=1.0,
            rawEndSec=end,
            startSec=1.0,
            endSec=end,
        )
        for end in (1.5, 2.0)
    ]

    result = reassign_notes(notes, {note.id for note in notes}, target.id, bpm=120)

    assert len(result.notes) == 1
    assert result.notes[0].end_sec == 2.0
