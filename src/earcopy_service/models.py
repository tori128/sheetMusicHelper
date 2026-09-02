from __future__ import annotations

from datetime import datetime
import math
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .instruments import get_instrument
from .transcription_profiles import TranscriptionProfile

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
    timeline_offset_sec: float = Field(default=0.0, alias="timelineOffsetSec")

    @field_validator("timeline_offset_sec")
    @classmethod
    def validate_timeline_offset(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("timelineOffsetSecは有限値である必要があります")
        return value


class Track(SchemaModel):
    id: UUID = Field(default_factory=uuid4)
    display_name: str = Field(min_length=1, max_length=120, alias="displayName")
    instrument_id: str = Field(alias="instrumentId")
    kind: Literal["pitched", "drums"]
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    order: int = Field(ge=1, le=16)
    midi_channel: int = Field(ge=1, le=16, alias="midiChannel")
    gm_program: int | None = Field(default=None, ge=0, le=127, alias="gmProgram")
    playback_octave_shift: Literal[0, 1] = Field(
        default=0,
        alias="playbackOctaveShift",
    )
    playback_volume: int = Field(
        default=100,
        ge=0,
        le=100,
        alias="playbackVolume",
    )
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
            if not instrument.supports_gm_program(self.gm_program):
                supported = ", ".join(
                    str(option.program) for option in instrument.gm_programs
                )
                raise ValueError(
                    f"{self.instrument_id} のProgramは {supported} から選択してください"
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


class ScoreChord(SchemaModel):
    start_sec: float = Field(ge=0, alias="startSec")
    end_sec: float = Field(gt=0, alias="endSec")
    label: str = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def validate_range(self) -> ScoreChord:
        if self.end_sec <= self.start_sec:
            raise ValueError("コード記号の終了位置は開始位置より後である必要があります")
        return self


class ScoreTrackSettings(SchemaModel):
    clef: Literal[
        "auto",
        "treble",
        "alto",
        "tenor",
        "bass",
        "percussion",
        "grand",
    ] = "auto"
    transposition_semitones: int = Field(
        default=0,
        ge=-24,
        le=24,
        alias="transpositionSemitones",
    )


class ScoreSettings(SchemaModel):
    composer: str = Field(default="", max_length=240)
    arranger: str = Field(default="", max_length=240)
    copyright: str = Field(default="", max_length=500)
    key_fifths: int = Field(default=0, ge=-7, le=7, alias="keyFifths")
    key_mode: Literal["major", "minor"] = Field(default="major", alias="keyMode")
    pickup_ticks: int = Field(default=0, ge=0, alias="pickupTicks")
    include_chord_symbols: bool = Field(default=True, alias="includeChordSymbols")
    chords: list[ScoreChord] = Field(default_factory=list)
    track_settings: dict[str, ScoreTrackSettings] = Field(
        default_factory=dict,
        alias="trackSettings",
    )


TranscriptionPass = Literal[
    "original_audio",
    "separated_audio",
    "drums_added_audio",
    "other_added_audio",
]
TranscriptionInputResultRole = Literal[
    "primary",
    "timing_reference",
]


class TranscriptionInputResult(SchemaModel):
    input_name: str = Field(min_length=1, alias="inputName")
    role: TranscriptionInputResultRole
    transcription_pass: TranscriptionPass = Field(alias="transcriptionPass")
    notes: list[Note]


class Transcription(SchemaModel):
    mode: Literal["direct", "separated"]
    transcription_profile: TranscriptionProfile = Field(
        alias="transcriptionProfile",
    )
    instrument_selection_mode: Literal["fixed", "automatic"] = Field(
        alias="instrumentSelectionMode",
    )
    preset_id: UUID | None = Field(alias="presetId")
    model_profile_id: UUID = Field(alias="modelProfileId")
    model_sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$", alias="modelSha256")
    backend: Literal["CPU", "CUDA"]
    drum_onset_guide: bool = Field(alias="drumOnsetGuide")
    timing_guide_note_filter: bool = Field(alias="timingGuideNoteFilter")
    velocity_from_stem_amplitude: bool = Field(
        alias="velocityFromStemAmplitude"
    )
    completed_at: datetime = Field(alias="completedAt")
    input_results: list[TranscriptionInputResult] = Field(alias="inputResults")


class Stem(SchemaModel):
    type: Literal[
        "drums",
        "bass",
        "vocals",
        "other",
        "piano",
        "guitar",
    ]
    cache_path: str = Field(alias="cachePath")
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    sample_rate: Literal[44100] = Field(default=44100, alias="sampleRate")
    channels: Literal[2] = 2
    mute: bool = False
    solo: bool = False


class Project(SchemaModel):
    format_version: Literal[5] = Field(default=5, alias="formatVersion")
    app_version: str = Field(default="0.1.0", alias="appVersion")
    project_id: UUID = Field(default_factory=uuid4, alias="projectId")
    name: str = Field(min_length=1, max_length=240)
    source_audio: SourceAudio | None = Field(default=None, alias="sourceAudio")
    tempo: Tempo = Field(default_factory=Tempo)
    transcription: Transcription | None = None
    tracks: list[Track] = Field(default_factory=list, max_length=16)
    notes: list[Note] = Field(default_factory=list)
    stems: list[Stem] = Field(default_factory=list, max_length=7)
    score: ScoreSettings = Field(default_factory=ScoreSettings)
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
        if self.transcription is not None:
            input_result_keys = [
                (result.input_name, result.role)
                for result in self.transcription.input_results
            ]
            if len(input_result_keys) != len(set(input_result_keys)):
                raise ValueError("採譜入力別ノートの識別子が重複しています")
            if not any(
                result.role == "primary"
                for result in self.transcription.input_results
            ):
                raise ValueError("採譜入力別ノートにprimaryがありません")
            if self.transcription.instrument_selection_mode == "fixed":
                unknown_input_result_tracks = {
                    note.track_id
                    for result in self.transcription.input_results
                    for note in result.notes
                } - known_track_ids
                if unknown_input_result_tracks:
                    raise ValueError(
                        "採譜入力別ノートが存在しないトラックを参照しています: "
                        f"{unknown_input_result_tracks}"
                    )
        tracks_by_text_id = {str(track.id): track for track in self.tracks}
        unknown_score_tracks = set(self.score.track_settings) - set(
            tracks_by_text_id
        )
        if unknown_score_tracks:
            raise ValueError(
                "存在しないトラックの記譜設定があります: "
                f"{unknown_score_tracks}"
            )
        for track_id, settings in self.score.track_settings.items():
            track = tracks_by_text_id[track_id]
            if track.kind == "drums" and settings.clef not in {
                "auto",
                "percussion",
            }:
                raise ValueError("ドラムトラックには打楽器用の音部記号を使用します")
            if track.kind == "drums" and settings.transposition_semitones:
                raise ValueError("ドラムトラックには記譜音高移調を設定できません")
            if track.kind == "pitched" and settings.clef == "percussion":
                raise ValueError("音程トラックには打楽器用の音部記号を使用できません")
        measure_ticks = (
            self.tempo.ppq
            * self.tempo.time_signature.numerator
            * 4
            // self.tempo.time_signature.denominator
        )
        if self.score.pickup_ticks >= measure_ticks:
            raise ValueError("弱起の長さは1小節未満である必要があります")
        return self

    @field_validator("tracks")
    @classmethod
    def sort_tracks(cls, tracks: list[Track]) -> list[Track]:
        return sorted(tracks, key=lambda track: track.order)
