from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .instruments import get_instrument

PPQ = 480
PITCHED_MIDI_CHANNELS = (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16)
QuantizeGrid = Literal["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"]


class SchemaModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class TimeSignature(SchemaModel):
    numerator: int = Field(default=4, ge=1, le=12)
    denominator: Literal[2, 4, 8, 16] = 4


class Tempo(SchemaModel):
    bpm: float = Field(default=120.0, ge=20.0, le=300.0)
    beat_offset_sec: float = Field(
        default=0.0,
        ge=0.0,
        alias="beatOffsetSec",
    )
    time_signature: TimeSignature = Field(
        default_factory=TimeSignature, alias="timeSignature"
    )
    ppq: Literal[480] = PPQ
    quantize_grid: QuantizeGrid = Field(default="1/16", alias="quantizeGrid")


class SourceAudio(SchemaModel):
    absolute_path: str = Field(alias="absolutePath")
    relative_path: str = Field(default="", alias="relativePath")
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    duration_sec: float = Field(ge=0, alias="durationSec")
    sample_rate: int = Field(gt=0, alias="sampleRate")
    channels: int = Field(ge=1)


class Track(SchemaModel):
    id: UUID = Field(default_factory=uuid4)
    display_name: str = Field(min_length=1, max_length=120, alias="displayName")
    instrument_id: str = Field(alias="instrumentId")
    kind: Literal["pitched", "drums"]
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    order: int = Field(ge=1, le=16)
    midi_channel: int = Field(ge=1, le=16, alias="midiChannel")
    gm_program: int | None = Field(default=None, ge=0, le=127, alias="gmProgram")
    mute: bool = False
    solo: bool = False

    @model_validator(mode="after")
    def validate_instrument_mapping(self) -> Track:
        instrument = get_instrument(self.instrument_id)
        if self.kind != instrument.kind:
            raise ValueError(
                f"{self.instrument_id} のkindは {instrument.kind} である必要があります"
            )
        if self.kind == "drums":
            if self.midi_channel != 10 or self.gm_program is not None:
                raise ValueError("ドラムはMIDIチャンネル10、Programなしである必要があります")
        else:
            if self.midi_channel == 10:
                raise ValueError("音程トラックへMIDIチャンネル10は割り当てられません")
            if self.gm_program != instrument.gm_program:
                raise ValueError(
                    f"{self.instrument_id} のProgramは {instrument.gm_program} です"
                )
        return self


class Note(SchemaModel):
    id: UUID = Field(default_factory=uuid4)
    source_instrument_id: str = Field(alias="sourceInstrumentId")
    track_id: UUID = Field(alias="trackId")
    pitch: int = Field(ge=0, le=127)
    raw_start_sec: float = Field(ge=0, alias="rawStartSec")
    raw_end_sec: float = Field(gt=0, alias="rawEndSec")
    start_sec: float = Field(ge=0, alias="startSec")
    end_sec: float = Field(gt=0, alias="endSec")
    velocity: int = Field(default=100, ge=1, le=127)

    @model_validator(mode="after")
    def validate_ranges(self) -> Note:
        if self.raw_end_sec <= self.raw_start_sec:
            raise ValueError("rawEndSecはrawStartSecより後である必要があります")
        if self.end_sec <= self.start_sec:
            raise ValueError("endSecはstartSecより後である必要があります")
        return self


class Transcription(SchemaModel):
    mode: Literal["direct", "four_stem"]
    preset_id: UUID = Field(alias="presetId")
    model_profile_id: UUID = Field(alias="modelProfileId")
    model_sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$", alias="modelSha256")
    backend: Literal["CPU", "CUDA"]
    completed_at: datetime = Field(alias="completedAt")


class Stem(SchemaModel):
    type: Literal["drums", "bass", "vocals", "other"]
    cache_path: str = Field(alias="cachePath")
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    sample_rate: Literal[44100] = Field(default=44100, alias="sampleRate")
    channels: Literal[2] = 2


class Project(SchemaModel):
    format_version: Literal[1] = Field(default=1, alias="formatVersion")
    app_version: str = Field(default="0.1.0", alias="appVersion")
    project_id: UUID = Field(default_factory=uuid4, alias="projectId")
    name: str = Field(min_length=1, max_length=240)
    source_audio: SourceAudio | None = Field(default=None, alias="sourceAudio")
    tempo: Tempo = Field(default_factory=Tempo)
    transcription: Transcription | None = None
    tracks: list[Track] = Field(default_factory=list, max_length=16)
    notes: list[Note] = Field(default_factory=list)
    stems: list[Stem] = Field(default_factory=list, max_length=4)
    view_state: dict[str, Any] = Field(default_factory=dict, alias="viewState")

    @model_validator(mode="after")
    def validate_project_relations(self) -> Project:
        track_ids = [track.id for track in self.tracks]
        if len(track_ids) != len(set(track_ids)):
            raise ValueError("トラックIDが重複しています")
        instrument_ids = [track.instrument_id for track in self.tracks]
        if len(instrument_ids) != len(set(instrument_ids)):
            raise ValueError("楽器グループIDが重複しています")
        if sum(track.kind == "drums" for track in self.tracks) > 1:
            raise ValueError("ドラムトラックは最大1件です")
        channels = [track.midi_channel for track in self.tracks]
        if len(channels) != len(set(channels)):
            raise ValueError("MIDIチャンネルが重複しています")
        known_track_ids = set(track_ids)
        unknown = {note.track_id for note in self.notes} - known_track_ids
        if unknown:
            raise ValueError(f"存在しないトラックを参照するノートがあります: {unknown}")
        return self

    @field_validator("tracks")
    @classmethod
    def sort_tracks(cls, tracks: list[Track]) -> list[Track]:
        return sorted(tracks, key=lambda track: track.order)
