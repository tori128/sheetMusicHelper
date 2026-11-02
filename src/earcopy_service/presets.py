from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid5

from .instruments import get_instrument
from .models import PITCHED_MIDI_CHANNELS, Project, Track

_PRESET_NAMESPACE = UUID("0b73f5d5-10cb-4e97-920f-cef06728d13d")


@dataclass(frozen=True, slots=True)
class PresetTrack:
    display_name: str
    instrument_id: str
    color: str


@dataclass(frozen=True, slots=True)
class BuiltinPreset:
    id: UUID
    key: str
    name: str
    tracks: tuple[PresetTrack, ...]


TRACK_COLOR_PALETTE = (
    "#4C9AFF",
    "#E85AAD",
    "#FFAB00",
    "#36B37E",
    "#FF7452",
    "#7A5AF8",
    "#00B8D9",
    "#FF8B00",
    "#9CC4FF",
    "#F39ACB",
    "#FFE380",
    "#79F2C0",
    "#FFBDAD",
    "#B8A7FF",
    "#82E9F4",
    "#FFC875",
)


def _preset(key: str, name: str, rows: tuple[tuple[str, str], ...]) -> BuiltinPreset:
    return BuiltinPreset(
        id=uuid5(_PRESET_NAMESPACE, key),
        key=key,
        name=name,
        tracks=tuple(
            PresetTrack(display_name, instrument_id, TRACK_COLOR_PALETTE[index])
            for index, (display_name, instrument_id) in enumerate(rows)
        ),
    )


BUILTIN_PRESETS: tuple[BuiltinPreset, ...] = (
    _preset(
        "general-band",
        "汎用バンド",
        (
            ("Piano", "acoustic_piano"),
            ("Distorted Electric Guitar", "distorted_electric_guitar"),
            ("Electric Bass", "electric_bass"),
            ("Vocal", "voice"),
            ("Drums", "drums"),
        ),
    ),
    _preset(
        "string-quartet",
        "弦楽四重奏",
        (
            ("Violin I / II", "violin"),
            ("Viola", "viola"),
            ("Cello", "cello"),
        ),
    ),
    _preset(
        "concert-band",
        "吹奏楽",
        (
            ("Flutes", "flutes"),
            ("Oboe", "oboe"),
            ("Bassoon", "bassoon"),
            ("Clarinet", "clarinet"),
            ("Soprano / Alto Sax", "soprano_and_alto_sax"),
            ("Tenor Sax", "tenor_sax"),
            ("Baritone Sax", "baritone_sax"),
            ("Trumpet", "trumpet"),
            ("French Horn", "french_horn"),
            ("Trombone", "trombone"),
            ("Tuba", "tuba"),
            ("Contrabass", "contrabass"),
            ("Timpani", "timpani"),
            ("Chromatic Percussion", "chromatic_percussion"),
            ("Percussion", "drums"),
        ),
    ),
    _preset(
        "orchestra",
        "オーケストラ",
        (
            ("Flutes", "flutes"),
            ("Oboe", "oboe"),
            ("Clarinet", "clarinet"),
            ("Bassoon", "bassoon"),
            ("French Horn", "french_horn"),
            ("Trumpet", "trumpet"),
            ("Trombone", "trombone"),
            ("Tuba", "tuba"),
            ("Violin", "violin"),
            ("Viola", "viola"),
            ("Cello", "cello"),
            ("Contrabass", "contrabass"),
            ("Orchestral Harp", "orchestral_harp"),
            ("Timpani", "timpani"),
            ("Chromatic Percussion", "chromatic_percussion"),
            ("Percussion", "drums"),
        ),
    ),
    _preset(
        "anime-song",
        "アニメソング",
        (
            ("Piano", "acoustic_piano"),
            ("Strings", "string_ensemble"),
            ("Acoustic Guitar", "acoustic_guitar"),
            ("Distorted Electric Guitar", "distorted_electric_guitar"),
            ("Electric Bass", "electric_bass"),
            ("Drums", "drums"),
            ("Timpani", "timpani"),
            ("Vocal", "voice"),
            ("Brass Section", "brass_section"),
        ),
    ),
)
PRESET_BY_ID = {preset.id: preset for preset in BUILTIN_PRESETS}
PRESET_BY_KEY = {preset.key: preset for preset in BUILTIN_PRESETS}


def tracks_from_preset(preset: BuiltinPreset) -> list[Track]:
    pitched_channel_index = 0
    result: list[Track] = []
    for order, item in enumerate(preset.tracks, start=1):
        instrument = get_instrument(item.instrument_id)
        if instrument.kind == "drums":
            midi_channel = 10
        else:
            midi_channel = PITCHED_MIDI_CHANNELS[pitched_channel_index]
            pitched_channel_index += 1
        result.append(
            Track(
                displayName=item.display_name,
                instrumentId=item.instrument_id,
                kind=instrument.kind,
                color=item.color,
                order=order,
                midiChannel=midi_channel,
                gmProgram=instrument.gm_program,
            )
        )
    return result


def create_project(name: str, preset: BuiltinPreset) -> Project:
    return Project(name=name, tracks=tracks_from_preset(preset))
