from __future__ import annotations

import math
from dataclasses import dataclass
from uuid import UUID

from .models import Note
from .timebase import seconds_to_ticks

MINIMUM_NOTE_DURATION_SEC = 0.01


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

    def __init__(self, instrument_track_ids: dict[str, UUID]) -> None:
        self._instrument_track_ids = instrument_track_ids
        self._pending: dict[int, NoteStartEvent] = {}
        self._corrected_count = 0
        self._discarded_count = 0

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def corrected_count(self) -> int:
        return self._corrected_count

    @property
    def discarded_count(self) -> int:
        return self._discarded_count

    def discard_pending(self) -> int:
        count = len(self._pending)
        self._pending.clear()
        self._discarded_count += count
        return count

    def feed(self, event: NoteStartEvent | NoteEndEvent) -> Note | None:
        if isinstance(event, NoteStartEvent):
            if event.event_index in self._pending:
                self._discarded_count += 1
            if (
                event.instrument_id not in self._instrument_track_ids
                or not 0 <= event.pitch <= 127
                or not math.isfinite(event.start_sec)
                or event.start_sec < 0
            ):
                self._discarded_count += 1
                self._pending.pop(event.event_index, None)
                return None
            self._pending[event.event_index] = event
            return None

        start = self._pending.pop(event.event_index, None)
        if start is None or not math.isfinite(event.end_sec):
            self._discarded_count += 1
            return None
        end_sec = event.end_sec
        if end_sec - start.start_sec < MINIMUM_NOTE_DURATION_SEC:
            end_sec = start.start_sec + MINIMUM_NOTE_DURATION_SEC
            self._corrected_count += 1
        return Note(
            sourceInstrumentId=start.instrument_id,
            trackId=self._instrument_track_ids[start.instrument_id],
            pitch=start.pitch,
            rawStartSec=start.start_sec,
            rawEndSec=end_sec,
            startSec=start.start_sec,
            endSec=end_sec,
            velocity=start.velocity,
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
