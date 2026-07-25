from __future__ import annotations

import json
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .instruments import get_instrument


class UserPresetTrack(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    display_name: str = Field(alias="displayName", min_length=1, max_length=120)
    instrument_id: str = Field(alias="instrumentId")
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    kind: Literal["pitched", "drums"]
    order: int = Field(ge=1, le=16)

    @model_validator(mode="after")
    def validate_instrument(self) -> UserPresetTrack:
        instrument = get_instrument(self.instrument_id)
        if self.kind != instrument.kind:
            raise ValueError(
                f"{self.instrument_id} のkindは {instrument.kind} です"
            )
        return self


class UserPreset(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    name: str = Field(min_length=1, max_length=120)
    tracks: list[UserPresetTrack] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def validate_tracks(self) -> UserPreset:
        instrument_ids = [track.instrument_id for track in self.tracks]
        if len(instrument_ids) != len(set(instrument_ids)):
            raise ValueError("同じ楽器グループを重複して登録できません")
        if sum(track.kind == "drums" for track in self.tracks) > 1:
            raise ValueError("ドラムトラックは最大1件です")
        orders = [track.order for track in self.tracks]
        if sorted(orders) != list(range(1, len(self.tracks) + 1)):
            raise ValueError("トラック順は1からの連番である必要があります")
        self.tracks.sort(key=lambda track: track.order)
        return self


class UserPresetStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def list(self) -> list[UserPreset]:
        if not self.path.is_file():
            return []
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise ValueError("ユーザープリセットファイルが不正です")
        return [UserPreset.model_validate(item) for item in payload]

    def save_as(self, name: str, tracks: list[UserPresetTrack]) -> UserPreset:
        preset = UserPreset(name=name.strip(), tracks=tracks)
        presets = self.list()
        presets.append(preset)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(
            json.dumps(
                [
                    item.model_dump(by_alias=True, mode="json")
                    for item in presets
                ],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        temporary.replace(self.path)
        return preset


def user_preset_response(preset: UserPreset) -> dict:
    return {
        "id": str(preset.id),
        "key": f"user:{preset.id}",
        "name": preset.name,
        "trackCount": len(preset.tracks),
        "tracks": [
            track.model_dump(by_alias=True, mode="json")
            for track in preset.tracks
        ],
    }
