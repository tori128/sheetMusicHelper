from __future__ import annotations

from collections import defaultdict
from typing import Literal

from pydantic import Field

from .models import Note, Project, QuantizeGrid, SchemaModel, Track
from .musicxml_export import build_musicxml
from .timebase import GRID_TICKS, note_score_ticks, score_origin_seconds


class ScoreValidationIssue(SchemaModel):
    code: str
    severity: Literal["error", "warning"]
    message: str
    track_id: str | None = Field(default=None, alias="trackId")
    note_ids: list[str] = Field(default_factory=list, alias="noteIds")
    time_sec: float = Field(default=0.0, ge=0, alias="timeSec")
    measure_number: int = Field(default=1, ge=0, alias="measureNumber")
    beat_number: float = Field(default=1.0, ge=1, alias="beatNumber")


class ScoreValidationResult(SchemaModel):
    issues: list[ScoreValidationIssue]
    error_count: int = Field(alias="errorCount")
    warning_count: int = Field(alias="warningCount")


def _measure_and_beat(project: Project, tick: int) -> tuple[int, float]:
    signature = project.tempo.time_signature
    beat_ticks = project.tempo.ppq * 4 // signature.denominator
    measure_ticks = beat_ticks * signature.numerator
    pickup_ticks = project.score.pickup_ticks
    if pickup_ticks > 0 and tick < pickup_ticks:
        return 0, 1 + tick / beat_ticks
    relative = tick - pickup_ticks if pickup_ticks > 0 else tick
    measure_index = relative // measure_ticks
    number = measure_index + 1
    return number, 1 + (relative % measure_ticks) / beat_ticks


def _issue_for_note(
    project: Project,
    note: Note,
    *,
    code: str,
    severity: Literal["error", "warning"],
    message: str,
    related: list[Note] | None = None,
) -> ScoreValidationIssue:
    tick, _end_tick = note_score_ticks(project, note)
    measure, beat = _measure_and_beat(project, tick)
    notes = related or [note]
    return ScoreValidationIssue(
        code=code,
        severity=severity,
        message=message,
        trackId=str(note.track_id),
        noteIds=[str(item.id) for item in notes],
        timeSec=note.start_sec,
        measureNumber=measure,
        beatNumber=round(beat, 3),
    )


def _off_grid_notes(
    project: Project,
    grid: QuantizeGrid,
    tolerance_ticks: int = 1,
) -> list[ScoreValidationIssue]:
    grid_ticks = GRID_TICKS[grid]
    grouped: dict[tuple[str, int], list[tuple[Note, int]]] = defaultdict(list)
    for note in project.notes:
        start_tick, end_tick = note_score_ticks(project, note)
        start_error = min(start_tick % grid_ticks, grid_ticks - start_tick % grid_ticks)
        end_error = min(end_tick % grid_ticks, grid_ticks - end_tick % grid_ticks)
        if start_error <= tolerance_ticks and end_error <= tolerance_ticks:
            continue
        measure, _beat = _measure_and_beat(project, start_tick)
        grouped[(str(note.track_id), measure)].append(
            (note, max(start_error, end_error))
        )

    tracks_by_id = {str(track.id): track for track in project.tracks}
    issues: list[ScoreValidationIssue] = []
    for (track_id, _measure), entries in grouped.items():
        entries.sort(key=lambda item: (item[0].start_sec, item[0].pitch))
        notes = [note for note, _error in entries]
        maximum_error = max(error for _note, error in entries)
        track = tracks_by_id[track_id]
        issues.append(
            _issue_for_note(
                project,
                notes[0],
                code="off_grid",
                severity="warning",
                message=(
                    f"{track.display_name}の{len(notes)}音が分解能{grid}の"
                    f"グリッドから最大{maximum_error} tick離れています"
                ),
                related=notes,
            )
        )
    return issues


def _overlap_issues(
    project: Project,
    tracks_by_id: dict[str, Track],
) -> list[ScoreValidationIssue]:
    grouped: dict[tuple[str, int], list[Note]] = defaultdict(list)
    for note in project.notes:
        grouped[(str(note.track_id), note.pitch)].append(note)
    issues: list[ScoreValidationIssue] = []
    for (track_id, pitch), notes in grouped.items():
        ordered = sorted(notes, key=lambda item: (item.start_sec, item.end_sec))
        for previous, current in zip(ordered, ordered[1:]):
            if current.start_sec >= previous.end_sec:
                continue
            track = tracks_by_id[track_id]
            issues.append(
                _issue_for_note(
                    project,
                    current,
                    code="same_pitch_overlap",
                    severity="error",
                    message=(
                        f"{track.display_name}のMIDIノート{pitch}が"
                        "同じ時刻範囲で重複しています"
                    ),
                    related=[previous, current],
                )
            )
    return issues


def validate_score(project: Project) -> ScoreValidationResult:
    tracks_by_id = {str(track.id): track for track in project.tracks}
    issues: list[ScoreValidationIssue] = []
    if not project.notes:
        issues.append(
            ScoreValidationIssue(
                code="empty_score",
                severity="error",
                message="書き出す音符がありません",
            )
        )
    origin = score_origin_seconds(project)
    for note in project.notes:
        track = tracks_by_id[str(note.track_id)]
        if note.start_sec < origin:
            issues.append(
                _issue_for_note(
                    project,
                    note,
                    code="before_score_origin",
                    severity="error",
                    message="音符が楽譜の開始位置より前にあります",
                )
            )
        settings = project.score.track_settings.get(str(track.id))
        transposition = (
            settings.transposition_semitones if settings is not None else 0
        )
        written_pitch = note.pitch + transposition
        if track.kind != "drums" and not 0 <= written_pitch <= 127:
            issues.append(
                _issue_for_note(
                    project,
                    note,
                    code="written_pitch_out_of_range",
                    severity="error",
                    message=(
                        f"{track.display_name}の記譜音高{written_pitch}は"
                        "MIDI音高0から127の範囲外です"
                    ),
                )
            )
    issues.extend(_overlap_issues(project, tracks_by_id))
    issues.extend(_off_grid_notes(project, project.tempo.quantize_grid))
    if project.score.pickup_ticks > 0 and origin == 0:
        pickup_seconds = (
            project.score.pickup_ticks
            * 60
            / (project.tempo.bpm * project.tempo.ppq)
        )
        if project.tempo.beat_offset_sec < pickup_seconds:
            issues.append(
                ScoreValidationIssue(
                    code="pickup_before_audio",
                    severity="error",
                    message="弱起の長さが1小節目先頭までの時間を超えています",
                )
            )
    try:
        build_musicxml(project)
    except ValueError as exc:
        issues.append(
            ScoreValidationIssue(
                code="musicxml_generation",
                severity="error",
                message=str(exc),
            )
        )
    issues.sort(
        key=lambda item: (
            0 if item.severity == "error" else 1,
            item.time_sec,
            item.code,
        )
    )
    return ScoreValidationResult(
        issues=issues,
        errorCount=sum(item.severity == "error" for item in issues),
        warningCount=sum(item.severity == "warning" for item in issues),
    )
