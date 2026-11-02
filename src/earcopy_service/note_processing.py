from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from .models import Note
from .timebase import seconds_to_ticks

MINIMUM_NOTE_DURATION_SEC = 0.01
MAXIMUM_NOTE_DURATION_SEC = 10.0
INVALID_RETRIGGER_WINDOW_SEC = 0.02
OVERLAP_EPSILON_SEC = 1e-6
CONTIGUOUS_NOTE_GAP_SEC = 0.02
ONSET_EVIDENCE_TOLERANCE_SEC = 0.06
MINIMUM_RETRIGGER_SUPPORT_RATIO = 0.15
ONSET_ANALYSIS_SAMPLE_RATE = 22_050
ONSET_ANALYSIS_HOP_LENGTH = 256
AUDIO_TAIL_WINDOW_SEC = 0.25
AUDIO_TAIL_RELEASE_SEC = 0.5
AUDIO_TAIL_RELATIVE_THRESHOLD_DB = -50.0
AUDIO_TAIL_ABSOLUTE_THRESHOLD_DBFS = -72.0
MINIMUM_FILTERABLE_AUDIO_TAIL_SEC = 1.0
TIMING_GUIDE_PITCH_EVIDENCE_WINDOW_SEC = 2.5
TIMING_GUIDE_SPLIT_MAX_GAP_SEC = CONTIGUOUS_NOTE_GAP_SEC
TIMING_GUIDE_REFERENCE_BOUNDARY_TOLERANCE_SEC = 0.06
TIMING_GUIDE_PARALLEL_ONSET_TOLERANCE_SEC = 0.06
PITCH_ACTIVITY_ANALYSIS_SAMPLE_RATE = 22_050
PITCH_ACTIVITY_ANALYSIS_HOP_LENGTH = 256
PITCH_ACTIVITY_MINIMUM_MIDI_NOTE = 24
PITCH_ACTIVITY_BIN_COUNT = 96
PITCH_ACTIVITY_MINIMUM_NOTE_DURATION_SEC = 1.0
PITCH_ACTIVITY_REFERENCE_DURATION_SEC = 0.75
PITCH_ACTIVITY_RELATIVE_THRESHOLD_DB = -20.0
PITCH_ACTIVITY_MINIMUM_INACTIVE_DURATION_SEC = 0.35
PITCH_ACTIVITY_RELEASE_DURATION_SEC = 0.1
CHUNK_BOUNDARY_TOLERANCE_SEC = 0.03
CHUNK_BOUNDARY_PITCH_REFERENCE_DURATION_SEC = 0.25
CHUNK_BOUNDARY_CONTINUATION_DETECTION_SEC = 0.15
CHUNK_BOUNDARY_MINIMUM_ACTIVE_CONTINUATION_SEC = 0.1


@dataclass(frozen=True, slots=True)
class NoteStartEvent:
    event_index: int
    instrument_id: str
    pitch: int
    start_sec: float
    velocity: int = 100


@dataclass(frozen=True, slots=True)
class NoteEndEvent:
    event_index: int
    end_sec: float


class NoteEventAssembler:
    """MuScriptorの開始・終了イベントを共通Noteへ結合する。"""

    def __init__(
        self,
        instrument_track_ids: dict[str, UUID],
        note_id_namespace: str | None = None,
    ) -> None:
        self._instrument_track_ids = instrument_track_ids
        self._note_id_namespace = note_id_namespace
        self._pending: dict[int, NoteStartEvent] = {}
        self._suppressed: dict[int, NoteStartEvent] = {}
        self._recent_invalid_ends: dict[tuple[str, int], float] = {}
        self._published_count = 0
        self._corrected_count = 0
        self._discarded_count = 0
        self._rejected_instrument_count = 0

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def corrected_count(self) -> int:
        return self._corrected_count

    @property
    def published_count(self) -> int:
        return self._published_count

    @property
    def discarded_count(self) -> int:
        return self._discarded_count

    @property
    def rejected_instrument_count(self) -> int:
        return self._rejected_instrument_count

    def discard_pending(self) -> int:
        count = len(self._pending)
        self._pending.clear()
        self._suppressed.clear()
        self._recent_invalid_ends.clear()
        self._discarded_count += count
        return count

    def feed(self, event: NoteStartEvent | NoteEndEvent) -> Note | None:
        if isinstance(event, NoteStartEvent):
            if event.event_index in self._pending:
                self._discarded_count += 1
            if event.instrument_id not in self._instrument_track_ids:
                self._suppressed[event.event_index] = event
                self._rejected_instrument_count += 1
                self._discarded_count += 1
                self._pending.pop(event.event_index, None)
                return None
            if (
                not 0 <= event.pitch <= 127
                or not math.isfinite(event.start_sec)
                or event.start_sec < 0
            ):
                self._discarded_count += 1
                self._pending.pop(event.event_index, None)
                return None
            key = (event.instrument_id, event.pitch)
            invalid_end = self._recent_invalid_ends.pop(key, None)
            if (
                invalid_end is not None
                and abs(event.start_sec - invalid_end)
                <= INVALID_RETRIGGER_WINDOW_SEC
            ):
                self._suppressed[event.event_index] = event
                self._discarded_count += 1
                return None
            self._pending[event.event_index] = event
            return None

        suppressed = self._suppressed.pop(event.event_index, None)
        if suppressed is not None:
            if (
                math.isfinite(event.end_sec)
                and event.end_sec - suppressed.start_sec
                <= MINIMUM_NOTE_DURATION_SEC + 1e-9
            ):
                self._recent_invalid_ends[
                    (suppressed.instrument_id, suppressed.pitch)
                ] = max(suppressed.start_sec, event.end_sec)
            return None

        start = self._pending.pop(event.event_index, None)
        if start is None or not math.isfinite(event.end_sec):
            self._discarded_count += 1
            return None
        duration_sec = event.end_sec - start.start_sec
        if (
            start.instrument_id != "drums"
            and duration_sec <= MINIMUM_NOTE_DURATION_SEC + 1e-9
        ):
            self._recent_invalid_ends[
                (start.instrument_id, start.pitch)
            ] = max(start.start_sec, event.end_sec)
            self._discarded_count += 1
            return None
        if duration_sec > MAXIMUM_NOTE_DURATION_SEC:
            self._discarded_count += 1
            return None
        end_sec = event.end_sec
        if duration_sec < MINIMUM_NOTE_DURATION_SEC:
            end_sec = start.start_sec + MINIMUM_NOTE_DURATION_SEC
            self._corrected_count += 1
        note_id = (
            uuid5(
                NAMESPACE_URL,
                f"earcopy:{self._note_id_namespace}:{start.event_index}",
            )
            if self._note_id_namespace is not None
            else None
        )
        note = Note(
            **({"id": note_id} if note_id is not None else {}),
            sourceInstrumentId=start.instrument_id,
            trackId=self._instrument_track_ids[start.instrument_id],
            pitch=start.pitch,
            rawStartSec=start.start_sec,
            rawEndSec=end_sec,
            startSec=start.start_sec,
            endSec=end_sec,
            velocity=start.velocity,
        )
        self._published_count += 1
        return note


@dataclass(frozen=True, slots=True)
class NoteChainFilterResult:
    notes: list[Note]
    discarded_count: int
    discarded_chains: int


@dataclass(frozen=True, slots=True)
class AudioTailFilterResult:
    notes: list[Note]
    discarded_count: int
    truncated_count: int


@dataclass(frozen=True, slots=True)
class TimingGuideNoteFilterResult:
    notes: list[Note]
    discarded_count: int
    merged_count: int


@dataclass(frozen=True, slots=True)
class PitchActivityEndFilterResult:
    notes: list[Note]
    truncated_count: int


@dataclass(frozen=True, slots=True)
class ChunkBoundarySustainExtensionResult:
    notes: list[Note]
    extended_count: int


def _load_pitch_activity(
    path: Path,
) -> tuple[Any, Any] | None:
    try:
        import librosa
        import numpy
        import soundfile

        audio, sample_rate = soundfile.read(
            path,
            dtype=numpy.float32,
            always_2d=True,
        )
        audio = numpy.mean(audio, axis=1, dtype=numpy.float32)
        if sample_rate != PITCH_ACTIVITY_ANALYSIS_SAMPLE_RATE:
            audio = librosa.resample(
                audio,
                orig_sr=sample_rate,
                target_sr=PITCH_ACTIVITY_ANALYSIS_SAMPLE_RATE,
            )
            sample_rate = PITCH_ACTIVITY_ANALYSIS_SAMPLE_RATE
        if not audio.size or not numpy.isfinite(audio).all():
            return None
        transform = librosa.cqt(
            audio,
            sr=sample_rate,
            hop_length=PITCH_ACTIVITY_ANALYSIS_HOP_LENGTH,
            fmin=librosa.midi_to_hz(PITCH_ACTIVITY_MINIMUM_MIDI_NOTE),
            n_bins=PITCH_ACTIVITY_BIN_COUNT,
            bins_per_octave=12,
            tuning=0.0,
            pad_mode="constant",
        )
        magnitudes = numpy.asarray(
            numpy.abs(transform),
            dtype=numpy.float32,
        )
        frame_times = librosa.frames_to_time(
            numpy.arange(magnitudes.shape[1]),
            sr=sample_rate,
            hop_length=PITCH_ACTIVITY_ANALYSIS_HOP_LENGTH,
        )
        return magnitudes, frame_times
    except (OSError, RuntimeError, TypeError, ValueError):
        return None


def extend_missing_chunk_boundary_sustains(
    notes: list[Note],
    evidence_paths: Mapping[str, Path],
    chunk_duration_sec: float,
    analysis_cache: dict[Path, tuple[Any, Any] | None] | None = None,
) -> ChunkBoundarySustainExtensionResult:
    """Extend notes omitted from the next inference chunk while pitch remains active."""

    import numpy

    if not math.isfinite(chunk_duration_sec) or chunk_duration_sec <= 0.0:
        raise ValueError("chunk_duration_sec must be positive and finite")

    cache = analysis_cache if analysis_cache is not None else {}
    note_starts_by_key: dict[tuple[str, int], list[float]] = {}
    for note in notes:
        if note.source_instrument_id == "drums":
            continue
        note_starts_by_key.setdefault(
            (note.source_instrument_id, note.pitch),
            [],
        ).append(note.raw_start_sec)
    for starts in note_starts_by_key.values():
        starts.sort()

    relative_threshold = math.pow(
        10.0,
        PITCH_ACTIVITY_RELATIVE_THRESHOLD_DB / 20.0,
    )
    selected: list[Note] = []
    extended_count = 0
    for note in notes:
        duration_sec = note.raw_end_sec - note.raw_start_sec
        evidence_path = evidence_paths.get(note.source_instrument_id)
        pitch_bin = note.pitch - PITCH_ACTIVITY_MINIMUM_MIDI_NOTE
        boundary_index = round(note.raw_end_sec / chunk_duration_sec)
        boundary_sec = boundary_index * chunk_duration_sec
        if (
            note.source_instrument_id == "drums"
            or duration_sec < PITCH_ACTIVITY_MINIMUM_NOTE_DURATION_SEC
            or boundary_index <= 0
            or abs(note.raw_end_sec - boundary_sec)
            > CHUNK_BOUNDARY_TOLERANCE_SEC + OVERLAP_EPSILON_SEC
            or evidence_path is None
            or not 0 <= pitch_bin < PITCH_ACTIVITY_BIN_COUNT
        ):
            selected.append(note)
            continue

        starts = note_starts_by_key[(note.source_instrument_id, note.pitch)]
        next_start_index = bisect_right(
            starts,
            note.raw_start_sec + OVERLAP_EPSILON_SEC,
        )
        next_start_sec = (
            starts[next_start_index]
            if next_start_index < len(starts)
            else None
        )
        if (
            next_start_sec is not None
            and next_start_sec
            <= note.raw_end_sec
            + CHUNK_BOUNDARY_CONTINUATION_DETECTION_SEC
        ):
            selected.append(note)
            continue

        if evidence_path not in cache:
            cache[evidence_path] = _load_pitch_activity(evidence_path)
        analysis = cache[evidence_path]
        if analysis is None:
            selected.append(note)
            continue

        magnitudes, frame_times = analysis
        reference_frames = numpy.flatnonzero(
            (frame_times >= max(
                note.raw_start_sec,
                note.raw_end_sec
                - CHUNK_BOUNDARY_PITCH_REFERENCE_DURATION_SEC,
            ))
            & (frame_times <= note.raw_end_sec)
        )
        if not reference_frames.size:
            selected.append(note)
            continue

        pitch_magnitudes = magnitudes[pitch_bin]
        reference_magnitude = float(
            numpy.percentile(pitch_magnitudes[reference_frames], 90)
        )
        if reference_magnitude <= numpy.finfo(numpy.float32).eps:
            selected.append(note)
            continue

        maximum_end_sec = min(
            note.raw_start_sec + MAXIMUM_NOTE_DURATION_SEC,
            float(frame_times[-1]),
        )
        if next_start_sec is not None:
            maximum_end_sec = min(maximum_end_sec, next_start_sec)
        continuation_frames = numpy.flatnonzero(
            (frame_times > note.raw_end_sec)
            & (frame_times <= maximum_end_sec)
        )
        if not continuation_frames.size:
            selected.append(note)
            continue

        activity_threshold = reference_magnitude * relative_threshold
        active_continuation_frames = continuation_frames[
            pitch_magnitudes[continuation_frames] >= activity_threshold
        ]
        if (
            not active_continuation_frames.size
            or float(frame_times[active_continuation_frames[0]])
            > note.raw_end_sec
            + CHUNK_BOUNDARY_CONTINUATION_DETECTION_SEC
            or float(frame_times[active_continuation_frames[-1]])
            < note.raw_end_sec
            + CHUNK_BOUNDARY_MINIMUM_ACTIVE_CONTINUATION_SEC
        ):
            selected.append(note)
            continue

        last_activity_sec: float | None = None
        inactive_start_sec: float | None = None
        for frame in continuation_frames:
            frame_sec = float(frame_times[frame])
            if pitch_magnitudes[frame] >= activity_threshold:
                last_activity_sec = frame_sec
                inactive_start_sec = None
                continue
            if last_activity_sec is None:
                continue
            if inactive_start_sec is None:
                inactive_start_sec = frame_sec
                continue
            if (
                frame_sec - inactive_start_sec
                >= PITCH_ACTIVITY_MINIMUM_INACTIVE_DURATION_SEC
            ):
                break

        if last_activity_sec is None:
            selected.append(note)
            continue
        extended_end_sec = min(
            maximum_end_sec,
            last_activity_sec + PITCH_ACTIVITY_RELEASE_DURATION_SEC,
        )
        if (
            extended_end_sec
            <= note.raw_end_sec + OVERLAP_EPSILON_SEC
        ):
            selected.append(note)
            continue
        selected.append(
            note.model_copy(
                update={
                    "raw_end_sec": extended_end_sec,
                    "end_sec": max(note.end_sec, extended_end_sec),
                }
            )
        )
        extended_count += 1

    return ChunkBoundarySustainExtensionResult(
        notes=selected,
        extended_count=extended_count,
    )


def trim_note_ends_without_pitch_activity(
    notes: list[Note],
    evidence_paths: Mapping[str, Path],
    analysis_cache: dict[Path, tuple[Any, Any] | None] | None = None,
) -> PitchActivityEndFilterResult:
    """Shorten pitched notes after their frequency component becomes inactive."""

    import numpy

    cache = analysis_cache if analysis_cache is not None else {}
    selected: list[Note] = []
    truncated_count = 0
    relative_threshold = math.pow(
        10.0,
        PITCH_ACTIVITY_RELATIVE_THRESHOLD_DB / 20.0,
    )
    for note in notes:
        duration_sec = note.raw_end_sec - note.raw_start_sec
        evidence_path = evidence_paths.get(note.source_instrument_id)
        pitch_bin = note.pitch - PITCH_ACTIVITY_MINIMUM_MIDI_NOTE
        if (
            note.source_instrument_id == "drums"
            or duration_sec < PITCH_ACTIVITY_MINIMUM_NOTE_DURATION_SEC
            or evidence_path is None
            or not 0 <= pitch_bin < PITCH_ACTIVITY_BIN_COUNT
        ):
            selected.append(note)
            continue
        if evidence_path not in cache:
            cache[evidence_path] = _load_pitch_activity(evidence_path)
        analysis = cache[evidence_path]
        if analysis is None:
            selected.append(note)
            continue

        magnitudes, frame_times = analysis
        note_frames = numpy.flatnonzero(
            (frame_times >= note.raw_start_sec)
            & (frame_times <= note.raw_end_sec)
        )
        reference_frames = numpy.flatnonzero(
            (frame_times >= note.raw_start_sec)
            & (
                frame_times
                < min(
                    note.raw_end_sec,
                    note.raw_start_sec
                    + PITCH_ACTIVITY_REFERENCE_DURATION_SEC,
                )
            )
        )
        if not note_frames.size or not reference_frames.size:
            selected.append(note)
            continue

        pitch_magnitudes = magnitudes[pitch_bin]
        reference_magnitude = float(
            numpy.percentile(pitch_magnitudes[reference_frames], 90)
        )
        if reference_magnitude <= numpy.finfo(numpy.float32).eps:
            selected.append(note)
            continue
        active_frames = note_frames[
            pitch_magnitudes[note_frames]
            >= reference_magnitude * relative_threshold
        ]
        if not active_frames.size:
            selected.append(note)
            continue

        last_activity_sec = float(frame_times[active_frames[-1]])
        if (
            note.raw_end_sec - last_activity_sec
            < PITCH_ACTIVITY_MINIMUM_INACTIVE_DURATION_SEC
        ):
            selected.append(note)
            continue
        raw_end_sec = min(
            note.raw_end_sec,
            last_activity_sec + PITCH_ACTIVITY_RELEASE_DURATION_SEC,
        )
        end_sec = min(note.end_sec, raw_end_sec)
        if (
            raw_end_sec - note.raw_start_sec
            <= MINIMUM_NOTE_DURATION_SEC + OVERLAP_EPSILON_SEC
            or end_sec - note.start_sec
            <= MINIMUM_NOTE_DURATION_SEC + OVERLAP_EPSILON_SEC
        ):
            selected.append(note)
            continue
        selected.append(
            note.model_copy(
                update={
                    "raw_end_sec": raw_end_sec,
                    "end_sec": end_sec,
                }
            )
        )
        truncated_count += 1

    return PitchActivityEndFilterResult(
        notes=selected,
        truncated_count=truncated_count,
    )


def filter_timing_guide_notes(
    guided_notes: list[Note],
    unmodified_notes: list[Note],
    *,
    pitch_evidence_window_sec: float = TIMING_GUIDE_PITCH_EVIDENCE_WINDOW_SEC,
) -> TimingGuideNoteFilterResult:
    """Filter guided notes and merge splits contradicted by the unmodified result."""

    if pitch_evidence_window_sec < 0.0:
        raise ValueError("pitch_evidence_window_sec must be non-negative")

    unmodified_by_pitch: dict[int, list[Note]] = {}
    for note in unmodified_notes:
        unmodified_by_pitch.setdefault(note.pitch, []).append(note)

    evidence_intervals: dict[int, tuple[list[float], list[float]]] = {}
    for pitch, notes in unmodified_by_pitch.items():
        ordered = sorted(notes, key=lambda note: note.raw_start_sec)
        starts = [note.raw_start_sec for note in ordered]
        maximum_ends: list[float] = []
        maximum_end = -math.inf
        for note in ordered:
            maximum_end = max(maximum_end, note.raw_end_sec)
            maximum_ends.append(maximum_end)
        evidence_intervals[pitch] = (starts, maximum_ends)

    def has_pitch_evidence(note: Note) -> bool:
        intervals = evidence_intervals.get(note.pitch)
        if intervals is None:
            return False
        starts, maximum_ends = intervals
        last_candidate = bisect_right(
            starts,
            note.raw_end_sec + pitch_evidence_window_sec,
        ) - 1
        return (
            last_candidate >= 0
            and maximum_ends[last_candidate]
            >= note.raw_start_sec - pitch_evidence_window_sec - 1e-9
        )

    selected = [note for note in guided_notes if has_pitch_evidence(note)]
    merged, merged_count = merge_timing_guide_split_notes(
        selected,
        unmodified_notes,
    )
    return TimingGuideNoteFilterResult(
        notes=merged,
        discarded_count=len(guided_notes) - len(selected),
        merged_count=merged_count,
    )


def merge_timing_guide_split_notes(
    guided_notes: list[Note],
    unmodified_notes: list[Note],
    *,
    maximum_gap_sec: float = TIMING_GUIDE_SPLIT_MAX_GAP_SEC,
    reference_boundary_tolerance_sec: float = (
        TIMING_GUIDE_REFERENCE_BOUNDARY_TOLERANCE_SEC
    ),
    parallel_onset_tolerance_sec: float = (
        TIMING_GUIDE_PARALLEL_ONSET_TOLERANCE_SEC
    ),
) -> tuple[list[Note], int]:
    """Merge adjacent guided notes covered by one unmodified note."""

    if maximum_gap_sec < 0.0:
        raise ValueError("maximum_gap_sec must be non-negative")
    if reference_boundary_tolerance_sec < 0.0:
        raise ValueError(
            "reference_boundary_tolerance_sec must be non-negative"
        )
    if parallel_onset_tolerance_sec < 0.0:
        raise ValueError("parallel_onset_tolerance_sec must be non-negative")

    references_by_pitch: dict[int, list[Note]] = {}
    for note in unmodified_notes:
        references_by_pitch.setdefault(note.pitch, []).append(note)
    for notes in references_by_pitch.values():
        notes.sort(key=lambda note: (note.raw_start_sec, note.raw_end_sec))

    guided_indices_by_key: dict[tuple[UUID, str, int], list[int]] = {}
    guided_onsets_by_pitch: dict[
        int,
        tuple[list[float], list[tuple[UUID, str]]],
    ] = {}
    for index, note in enumerate(guided_notes):
        key = (note.track_id, note.source_instrument_id, note.pitch)
        guided_indices_by_key.setdefault(key, []).append(index)
    for pitch in {note.pitch for note in guided_notes}:
        events = sorted(
            (
                note.raw_start_sec,
                (note.track_id, note.source_instrument_id),
            )
            for note in guided_notes
            if note.pitch == pitch
        )
        guided_onsets_by_pitch[pitch] = (
            [event[0] for event in events],
            [event[1] for event in events],
        )

    def has_parallel_onset(note: Note) -> bool:
        starts, track_keys = guided_onsets_by_pitch[note.pitch]
        first = bisect_left(
            starts,
            note.raw_start_sec - parallel_onset_tolerance_sec,
        )
        stop = bisect_right(
            starts,
            note.raw_start_sec + parallel_onset_tolerance_sec,
        )
        note_key = (note.track_id, note.source_instrument_id)
        return any(track_keys[index] != note_key for index in range(first, stop))

    replacements: dict[int, Note] = {}
    removed_indices: set[int] = set()
    for indices in guided_indices_by_key.values():
        ordered_indices = sorted(
            indices,
            key=lambda index: (
                guided_notes[index].raw_start_sec,
                guided_notes[index].raw_end_sec,
            ),
        )
        position = 0
        while position < len(ordered_indices):
            first_index = ordered_indices[position]
            first = guided_notes[first_index]
            references = references_by_pitch.get(first.pitch, [])
            supporting_references = [
                reference
                for reference in references
                if reference.raw_start_sec
                <= first.raw_start_sec + reference_boundary_tolerance_sec
                and reference.raw_end_sec
                >= first.raw_end_sec - reference_boundary_tolerance_sec
            ]
            run_indices = [first_index]
            run_end_sec = first.raw_end_sec
            next_position = position + 1

            while next_position < len(ordered_indices) and supporting_references:
                next_index = ordered_indices[next_position]
                next_note = guided_notes[next_index]
                previous_note = guided_notes[run_indices[-1]]
                gap_sec = next_note.raw_start_sec - previous_note.raw_end_sec
                if abs(gap_sec) > maximum_gap_sec + OVERLAP_EPSILON_SEC:
                    break

                candidate_end_sec = max(run_end_sec, next_note.raw_end_sec)
                if has_parallel_onset(next_note):
                    break
                supported = []
                for reference in supporting_references:
                    if (
                        reference.raw_end_sec
                        < candidate_end_sec
                        - reference_boundary_tolerance_sec
                    ):
                        continue
                    if any(
                        other.id != reference.id
                        and first.raw_start_sec
                        + reference_boundary_tolerance_sec
                        < other.raw_start_sec
                        < candidate_end_sec
                        - reference_boundary_tolerance_sec
                        for other in references
                    ):
                        continue
                    supported.append(reference)
                if not supported:
                    break

                supporting_references = supported
                run_indices.append(next_index)
                run_end_sec = candidate_end_sec
                next_position += 1

            if len(run_indices) > 1:
                run_notes = [guided_notes[index] for index in run_indices]
                replacements[first_index] = first.model_copy(
                    update={
                        "raw_end_sec": max(
                            note.raw_end_sec for note in run_notes
                        ),
                        "end_sec": max(note.end_sec for note in run_notes),
                    }
                )
                removed_indices.update(run_indices[1:])
            position = (
                next_position
                if next_position > position + 1
                else position + 1
            )

    return (
        [
            replacements.get(index, note)
            for index, note in enumerate(guided_notes)
            if index not in removed_indices
        ],
        len(removed_indices),
    )




def detect_effective_audio_end(path: Path) -> float | None:
    """Return the end of the trailing audible signal, or None on read failure."""

    try:
        import numpy
        import soundfile

        info = soundfile.info(path)
        duration_sec = info.frames / info.samplerate
        window_frames = max(
            1,
            round(info.samplerate * AUDIO_TAIL_WINDOW_SEC),
        )
        rms_values: list[float] = []
        with soundfile.SoundFile(path) as audio_file:
            while True:
                audio = audio_file.read(
                    window_frames,
                    dtype="float32",
                    always_2d=True,
                )
                if not len(audio):
                    break
                rms_values.append(
                    float(
                        numpy.sqrt(
                            numpy.mean(
                                numpy.square(
                                    audio,
                                    dtype=numpy.float64,
                                )
                            )
                        )
                    )
                )
    except (OSError, RuntimeError, TypeError, ValueError):
        return None

    if not rms_values:
        return 0.0
    peak_rms = max(rms_values)
    relative_threshold = peak_rms * math.pow(
        10.0,
        AUDIO_TAIL_RELATIVE_THRESHOLD_DB / 20.0,
    )
    absolute_threshold = math.pow(
        10.0,
        AUDIO_TAIL_ABSOLUTE_THRESHOLD_DBFS / 20.0,
    )
    threshold = max(relative_threshold, absolute_threshold)
    active_windows = [
        index
        for index, rms in enumerate(rms_values)
        if rms >= threshold
    ]
    if not active_windows:
        return 0.0
    effective_end_sec = min(
        duration_sec,
        (active_windows[-1] + 1) * AUDIO_TAIL_WINDOW_SEC
        + AUDIO_TAIL_RELEASE_SEC,
    )
    if duration_sec - effective_end_sec < MINIMUM_FILTERABLE_AUDIO_TAIL_SEC:
        return duration_sec
    return effective_end_sec


def filter_notes_after_audio_tail(
    notes: list[Note],
    evidence_paths: Mapping[str, Path],
    effective_end_cache: dict[Path, float | None] | None = None,
) -> AudioTailFilterResult:
    """Discard model events after a source stem's trailing audible signal."""

    cache = effective_end_cache if effective_end_cache is not None else {}
    filtered_notes: list[Note] = []
    discarded_count = 0
    truncated_count = 0
    for note in notes:
        evidence_path = evidence_paths.get(note.source_instrument_id)
        if evidence_path is None:
            filtered_notes.append(note)
            continue
        if evidence_path not in cache:
            cache[evidence_path] = detect_effective_audio_end(evidence_path)
        effective_end_sec = cache[evidence_path]
        if effective_end_sec is None:
            filtered_notes.append(note)
            continue
        if note.raw_start_sec >= effective_end_sec - OVERLAP_EPSILON_SEC:
            discarded_count += 1
            continue
        if note.raw_end_sec <= effective_end_sec:
            filtered_notes.append(note)
            continue
        raw_end_sec = effective_end_sec
        end_sec = min(note.end_sec, effective_end_sec)
        if (
            raw_end_sec - note.raw_start_sec
            <= MINIMUM_NOTE_DURATION_SEC + OVERLAP_EPSILON_SEC
            or end_sec - note.start_sec
            <= MINIMUM_NOTE_DURATION_SEC + OVERLAP_EPSILON_SEC
        ):
            discarded_count += 1
            continue
        filtered_notes.append(
            note.model_copy(
                update={
                    "raw_end_sec": raw_end_sec,
                    "end_sec": end_sec,
                }
            )
        )
        truncated_count += 1

    return AudioTailFilterResult(
        notes=filtered_notes,
        discarded_count=discarded_count,
        truncated_count=truncated_count,
    )


def _has_retrigger_evidence(path: Path, chain: list[Note]) -> bool:
    retrigger_times = [note.raw_start_sec for note in chain[1:]]
    if not retrigger_times:
        return True

    padding_sec = ONSET_EVIDENCE_TOLERANCE_SEC * 2
    offset_sec = max(0.0, min(retrigger_times) - padding_sec)
    end_sec = max(note.raw_end_sec for note in chain) + padding_sec
    try:
        import librosa
        import numpy

        audio, sample_rate = librosa.load(
            path,
            sr=ONSET_ANALYSIS_SAMPLE_RATE,
            mono=True,
            offset=offset_sec,
            duration=max(0.0, end_sec - offset_sec),
        )
        if not audio.size or not numpy.isfinite(audio).all():
            return False
        onset_envelope = librosa.onset.onset_strength(
            y=audio,
            sr=sample_rate,
            hop_length=ONSET_ANALYSIS_HOP_LENGTH,
        )
        onset_frames = librosa.onset.onset_detect(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            hop_length=ONSET_ANALYSIS_HOP_LENGTH,
            units="frames",
        )
        onset_times = (
            librosa.frames_to_time(
                onset_frames,
                sr=sample_rate,
                hop_length=ONSET_ANALYSIS_HOP_LENGTH,
            )
            + offset_sec
        )
    except (OSError, RuntimeError, ValueError):
        return False

    unused_onsets = set(range(len(onset_times)))
    matched_retriggers = 0
    for retrigger_time in retrigger_times:
        candidates = [
            index
            for index in unused_onsets
            if abs(float(onset_times[index]) - retrigger_time)
            <= ONSET_EVIDENCE_TOLERANCE_SEC
        ]
        if not candidates:
            continue
        matched_index = min(
            candidates,
            key=lambda index: abs(float(onset_times[index]) - retrigger_time),
        )
        unused_onsets.remove(matched_index)
        matched_retriggers += 1

    return (
        matched_retriggers / len(retrigger_times)
        >= MINIMUM_RETRIGGER_SUPPORT_RATIO
    )


def filter_pathological_note_chains(
    notes: list[Note],
    evidence_paths: Mapping[str, Path] | None = None,
) -> NoteChainFilterResult:
    """音源で再発音を確認できない、10秒超の同音高ノート列を無効化する。"""

    notes_by_key: dict[tuple[UUID, int], list[Note]] = {}
    for note in notes:
        if note.source_instrument_id == "drums":
            continue
        notes_by_key.setdefault((note.track_id, note.pitch), []).append(note)

    discarded_ids: set[UUID] = set()
    discarded_chains = 0

    def reject_if_pathological(
        chain: list[Note],
        *,
        contains_overlap: bool,
    ) -> None:
        nonlocal discarded_chains
        if len(chain) < 2:
            return
        chain_start = min(note.raw_start_sec for note in chain)
        chain_end = max(note.raw_end_sec for note in chain)
        if chain_end - chain_start <= MAXIMUM_NOTE_DURATION_SEC:
            return
        evidence_path = (
            evidence_paths.get(chain[0].source_instrument_id)
            if evidence_paths is not None
            else None
        )
        if (
            not contains_overlap
            and evidence_path is not None
            and _has_retrigger_evidence(evidence_path, chain)
        ):
            return
        discarded_ids.update(note.id for note in chain)
        discarded_chains += 1

    for group in notes_by_key.values():
        ordered = sorted(
            group,
            key=lambda note: (
                note.raw_start_sec,
                note.raw_end_sec,
                str(note.id),
            ),
        )
        chain: list[Note] = []
        chain_end = 0.0
        contains_overlap = False
        for note in ordered:
            if not chain:
                chain = [note]
                chain_end = note.raw_end_sec
                continue
            if note.raw_start_sec <= chain_end + CONTIGUOUS_NOTE_GAP_SEC:
                contains_overlap = contains_overlap or (
                    note.raw_start_sec < chain_end - OVERLAP_EPSILON_SEC
                )
                chain.append(note)
                chain_end = max(chain_end, note.raw_end_sec)
                continue
            reject_if_pathological(
                chain,
                contains_overlap=contains_overlap,
            )
            chain = [note]
            chain_end = note.raw_end_sec
            contains_overlap = False
        reject_if_pathological(
            chain,
            contains_overlap=contains_overlap,
        )

    return NoteChainFilterResult(
        notes=[note for note in notes if note.id not in discarded_ids],
        discarded_count=len(discarded_ids),
        discarded_chains=discarded_chains,
    )


@dataclass(frozen=True, slots=True)
class AssignmentResult:
    notes: list[Note]
    selected_note_ids: set[UUID]


def reassign_notes(
    notes: list[Note],
    selected_note_ids: set[UUID],
    target_track_id: UUID,
    bpm: float,
) -> AssignmentResult:
    """選択ノートを移動し、(track, pitch, startTick)の重複を解決する。"""

    moving = [note for note in notes if note.id in selected_note_ids]
    if not moving:
        return AssignmentResult(notes=list(notes), selected_note_ids=set())

    winners: dict[tuple[UUID, int, int], Note] = {}
    for note in moving:
        moved = note.model_copy(update={"track_id": target_track_id})
        key = (
            target_track_id,
            moved.pitch,
            seconds_to_ticks(moved.start_sec, bpm),
        )
        current = winners.get(key)
        if current is None or seconds_to_ticks(
            moved.end_sec, bpm
        ) > seconds_to_ticks(current.end_sec, bpm):
            winners[key] = moved

    winner_keys = set(winners)
    remaining = []
    for note in notes:
        if note.id in selected_note_ids:
            continue
        key = (note.track_id, note.pitch, seconds_to_ticks(note.start_sec, bpm))
        if key not in winner_keys:
            remaining.append(note)

    result = remaining + list(winners.values())
    result.sort(key=lambda note: (note.start_sec, note.pitch, str(note.id)))
    return AssignmentResult(
        notes=result,
        selected_note_ids={note.id for note in winners.values()},
    )
