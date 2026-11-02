from uuid import UUID

from earcopy_service.models import Note, TranscriptionInputResult
from earcopy_service.transcription_option_processing import (
    apply_saved_transcription_options,
)


TRACK_ID = UUID("00000000-0000-0000-0000-000000000001")


def note(
    note_id: int,
    pitch: int,
    start_sec: float,
    duration_sec: float = 0.5,
) -> Note:
    return Note(
        id=UUID(f"00000000-0000-0000-0000-{note_id:012d}"),
        sourceInstrumentId="acoustic_piano",
        trackId=TRACK_ID,
        pitch=pitch,
        rawStartSec=start_sec,
        rawEndSec=start_sec + duration_sec,
        startSec=start_sec,
        endSec=start_sec + duration_sec,
    )


def test_timing_filter_is_recomputed_from_saved_input_results() -> None:
    supported = note(1, 60, 1.0)
    unsupported = note(2, 62, 2.0)
    input_results = [
        TranscriptionInputResult(
            inputName="piano",
            role="primary",
            transcriptionPass="drums_added_audio",
            notes=[supported, unsupported],
        ),
        TranscriptionInputResult(
            inputName="piano",
            role="timing_reference",
            transcriptionPass="separated_audio",
            notes=[note(3, 60, 1.0)],
        ),
    ]

    filtered = apply_saved_transcription_options(
        input_results,
        [],
        "automatic",
        timing_guide_note_filter=True,
    )
    unfiltered = apply_saved_transcription_options(
        input_results,
        [],
        "automatic",
        timing_guide_note_filter=False,
    )

    assert [result.id for result in filtered] == [supported.id]
    assert [result.id for result in unfiltered] == [
        supported.id,
        unsupported.id,
    ]


def test_split_merge_is_recomputed_from_saved_input_results() -> None:
    first = note(1, 60, 1.0, 0.3)
    second = note(2, 60, 1.3, 0.3)
    reference = note(3, 60, 1.0, 0.6)
    input_results = [
        TranscriptionInputResult(
            inputName="piano",
            role="primary",
            transcriptionPass="drums_added_audio",
            notes=[first, second],
        ),
        TranscriptionInputResult(
            inputName="piano",
            role="timing_reference",
            transcriptionPass="separated_audio",
            notes=[reference],
        ),
    ]

    filtered = apply_saved_transcription_options(
        input_results,
        [],
        "automatic",
        timing_guide_note_filter=True,
    )
    unfiltered = apply_saved_transcription_options(
        input_results,
        [],
        "automatic",
        timing_guide_note_filter=False,
    )

    assert filtered == [
        first.model_copy(
            update={"raw_end_sec": 1.6, "end_sec": 1.6}
        )
    ]
    assert unfiltered == [first, second]
