from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .backends import BackendInvalidChunk
from .models import Note
from .note_processing import (
    extend_missing_chunk_boundary_sustains,
    filter_notes_after_audio_tail,
    filter_pathological_note_chains,
    trim_note_ends_without_pitch_activity,
)


@dataclass(frozen=True, slots=True)
class TranscriptionPostprocessingResult:
    notes: list[Note]
    invalid_chunk_discarded_count: int
    audio_tail_discarded_count: int
    audio_tail_truncated_count: int
    chunk_boundary_extended_count: int
    pitch_inactive_truncated_count: int
    pathological_chain_discarded_count: int
    pathological_chain_count: int


def postprocess_transcription_notes(
    notes: Sequence[Note],
    invalid_chunks: Sequence[BackendInvalidChunk],
    evidence_paths: Mapping[str, Path],
    effective_audio_end_cache: dict[Path, float | None],
    pitch_activity_cache: dict[Path, tuple[Any, Any] | None],
    *,
    missing_sustain_chunk_duration_sec: float | None,
) -> TranscriptionPostprocessingResult:
    valid_notes = [
        note
        for note in notes
        if not any(
            note.raw_start_sec < invalid.end_sec
            and note.raw_end_sec > invalid.start_sec
            for invalid in invalid_chunks
        )
    ]
    tail_filtered = filter_notes_after_audio_tail(
        valid_notes,
        evidence_paths,
        effective_audio_end_cache,
    )
    chunk_boundary_extended = (
        extend_missing_chunk_boundary_sustains(
            tail_filtered.notes,
            evidence_paths,
            missing_sustain_chunk_duration_sec,
            pitch_activity_cache,
        )
        if missing_sustain_chunk_duration_sec is not None
        else None
    )
    pitch_activity_filtered = trim_note_ends_without_pitch_activity(
        (
            chunk_boundary_extended.notes
            if chunk_boundary_extended is not None
            else tail_filtered.notes
        ),
        evidence_paths,
        pitch_activity_cache,
    )
    pathological_chain_filtered = filter_pathological_note_chains(
        pitch_activity_filtered.notes,
        evidence_paths,
    )
    original_end_by_note_id = {
        note.id: note.raw_end_sec for note in tail_filtered.notes
    }
    return TranscriptionPostprocessingResult(
        notes=pathological_chain_filtered.notes,
        invalid_chunk_discarded_count=len(notes) - len(valid_notes),
        audio_tail_discarded_count=tail_filtered.discarded_count,
        audio_tail_truncated_count=tail_filtered.truncated_count,
        chunk_boundary_extended_count=sum(
            note.raw_end_sec
            > original_end_by_note_id[note.id] + 1e-6
            for note in pathological_chain_filtered.notes
        ),
        pitch_inactive_truncated_count=pitch_activity_filtered.truncated_count,
        pathological_chain_discarded_count=(
            pathological_chain_filtered.discarded_count
        ),
        pathological_chain_count=(
            pathological_chain_filtered.discarded_chains
        ),
    )
