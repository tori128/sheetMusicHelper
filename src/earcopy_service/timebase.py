from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from .models import Note, Project, QuantizeGrid

GRID_TICKS: dict[QuantizeGrid, int] = {
    "1/4": 480,
    "1/8": 240,
    "1/16": 120,
    "1/32": 60,
    "1/8T": 160,
    "1/16T": 80,
}


def _round_half_up(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def seconds_to_ticks(seconds: float, bpm: float, ppq: int = 480) -> int:
    if seconds < 0:
        raise ValueError("secondsは0以上である必要があります")
    if bpm <= 0:
        raise ValueError("bpmは0より大きい必要があります")
    return _round_half_up(seconds * bpm * ppq / 60)


def ticks_to_seconds(ticks: int, bpm: float, ppq: int = 480) -> float:
    if ticks < 0:
        raise ValueError("ticksは0以上である必要があります")
    if bpm <= 0:
        raise ValueError("bpmは0より大きい必要があります")
    return ticks * 60 / (bpm * ppq)


def score_origin_seconds(project: Project) -> float:
    pickup_seconds = ticks_to_seconds(
        project.score.pickup_ticks,
        project.tempo.bpm,
        project.tempo.ppq,
    )
    return max(0.0, project.tempo.beat_offset_sec - pickup_seconds)


def score_time_to_ticks(project: Project, seconds: float) -> int:
    absolute_tick = seconds_to_ticks(
        seconds,
        project.tempo.bpm,
        project.tempo.ppq,
    )
    origin_tick = seconds_to_ticks(
        score_origin_seconds(project),
        project.tempo.bpm,
        project.tempo.ppq,
    )
    return max(0, absolute_tick - origin_tick)


def note_score_ticks(project: Project, note: Note) -> tuple[int, int]:
    start_tick = score_time_to_ticks(project, note.start_sec)
    end_tick = score_time_to_ticks(project, note.end_sec)
    return start_tick, max(start_tick + 1, end_tick)


def quantize_tick(tick: int, grid_tick: int) -> int:
    if grid_tick <= 0:
        raise ValueError("grid_tickは0より大きい必要があります")
    return _round_half_up(tick / grid_tick) * grid_tick


def quantize_note(
    note: Note,
    bpm: float,
    grid: QuantizeGrid,
    beat_offset_sec: float = 0.0,
) -> Note:
    grid_tick = GRID_TICKS[grid]
    grid_sec = ticks_to_seconds(grid_tick, bpm)

    def snap(time_sec: float) -> float:
        return max(
            0.0,
            beat_offset_sec
            + _round_half_up((time_sec - beat_offset_sec) / grid_sec) * grid_sec,
        )

    start_sec = snap(note.start_sec)
    end_sec = max(snap(note.end_sec), start_sec + grid_sec)
    return note.model_copy(
        update={
            "start_sec": start_sec,
            "end_sec": end_sec,
        }
    )


def quantize_project(project: Project, grid: QuantizeGrid) -> Project:
    tempo = project.tempo.model_copy(update={"quantize_grid": grid})
    notes = [
        quantize_note(note, tempo.bpm, grid, tempo.beat_offset_sec)
        for note in project.notes
    ]
    return project.model_copy(update={"tempo": tempo, "notes": notes})
