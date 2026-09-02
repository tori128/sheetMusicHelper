from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from .instrument_routing import collapse_mapped_family_duplicates
from .models import (
    Note,
    Track,
    TranscriptionInputResult,
    TranscriptionInputResultRole,
)
from .note_processing import filter_timing_guide_notes
from .transcription_inputs import TIMING_GUIDE_NOTE_FILTER_INPUTS


def _required_result(
    results: dict[tuple[str, str], TranscriptionInputResult],
    input_name: str,
    role: TranscriptionInputResultRole,
) -> TranscriptionInputResult:
    result = results.get((input_name, role))
    if result is None:
        raise ValueError(
            "採譜入力別ノートが不足しています: "
            f"inputName={input_name}, role={role}"
        )
    return result


def apply_saved_transcription_options(
    input_results: Iterable[TranscriptionInputResult],
    tracks: list[Track],
    instrument_selection_mode: Literal["fixed", "automatic"],
    timing_guide_note_filter: bool,
) -> list[Note]:
    result_items = list(input_results)
    result_by_key = {
        (result.input_name, result.role): result for result in result_items
    }
    if len(result_by_key) != len(result_items):
        raise ValueError("採譜入力別ノートの識別子が重複しています")
    primary_results = [
        result for result in result_by_key.values() if result.role == "primary"
    ]
    if not primary_results:
        raise ValueError("採譜入力別ノートにprimaryがありません")

    selected_instrument_by_track_id = {
        track.id: track.instrument_id for track in tracks
    }
    output: list[Note] = []
    for primary in primary_results:
        notes = list(primary.notes)
        if (
            timing_guide_note_filter
            and primary.input_name in TIMING_GUIDE_NOTE_FILTER_INPUTS
            and primary.transcription_pass == "drums_added_audio"
        ):
            timing_reference = _required_result(
                result_by_key,
                primary.input_name,
                "timing_reference",
            )
            notes = filter_timing_guide_notes(
                notes,
                timing_reference.notes,
            ).notes
        if instrument_selection_mode == "fixed":
            notes, _ = collapse_mapped_family_duplicates(
                notes,
                selected_instrument_by_track_id,
            )
        output.extend(notes)

    return sorted(
        output,
        key=lambda note: (
            note.raw_start_sec,
            note.pitch,
            note.source_instrument_id,
            str(note.id),
        ),
    )
