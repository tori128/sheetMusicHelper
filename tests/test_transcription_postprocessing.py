from pathlib import Path
from uuid import UUID

from earcopy_service.backends import BackendInvalidChunk
from earcopy_service.models import Note
from earcopy_service.transcription_postprocessing import (
    TranscriptionPostprocessingResult,
    postprocess_transcription_notes,
)


TRACK_ID = UUID("00000000-0000-0000-0000-000000000001")


def _note(start_sec: float, end_sec: float, *, pitch: int = 60) -> Note:
    return Note(
        sourceInstrumentId="acoustic_piano",
        trackId=TRACK_ID,
        pitch=pitch,
        rawStartSec=start_sec,
        rawEndSec=end_sec,
        startSec=start_sec,
        endSec=end_sec,
        velocity=100,
    )


def _postprocess(
    notes: list[Note],
    invalid_chunks: list[BackendInvalidChunk] | None = None,
) -> TranscriptionPostprocessingResult:
    return postprocess_transcription_notes(
        notes,
        invalid_chunks or [],
        {},
        {},
        {},
        missing_sustain_chunk_duration_sec=None,
    )


def test_invalid_chunk_filter_discards_only_overlapping_notes() -> None:
    ends_at_boundary = _note(0.5, 1.0)
    overlaps_start = _note(0.75, 1.25, pitch=61)
    inside = _note(1.25, 1.75, pitch=62)
    starts_at_boundary = _note(2.0, 2.5, pitch=63)

    result = _postprocess(
        [ends_at_boundary, overlaps_start, inside, starts_at_boundary],
        [
            BackendInvalidChunk(
                chunk_index=0,
                start_sec=1.0,
                end_sec=2.0,
                reason="test",
            )
        ],
    )

    assert [note.id for note in result.notes] == [
        ends_at_boundary.id,
        starts_at_boundary.id,
    ]
    assert result.invalid_chunk_discarded_count == 2
    assert result.audio_tail_discarded_count == 0
    assert result.audio_tail_truncated_count == 0
    assert result.chunk_boundary_extended_count == 0
    assert result.pitch_inactive_truncated_count == 0
    assert result.pathological_chain_discarded_count == 0
    assert result.pathological_chain_count == 0


def test_postprocessing_discards_contiguous_pathological_note_chain() -> None:
    first = _note(0.0, 6.0)
    second = _note(6.0, 12.0)
    independent = _note(13.0, 14.0, pitch=62)

    result = _postprocess([first, second, independent])

    assert [note.id for note in result.notes] == [independent.id]
    assert result.pathological_chain_discarded_count == 2
    assert result.pathological_chain_count == 1


def test_missing_audio_evidence_preserves_valid_notes() -> None:
    note = _note(0.25, 0.75)

    result = postprocess_transcription_notes(
        [note],
        [],
        {"different_instrument": Path("unused.wav")},
        {},
        {},
        missing_sustain_chunk_duration_sec=None,
    )

    assert result.notes == [note]
