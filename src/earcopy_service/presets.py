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


def _preset(key: str, name: str, rows: tuple[tuple[str, str, str], ...]) -> BuiltinPreset:
    return BuiltinPreset(
        id=uuid5(_PRESET_NAMESPACE, key),
        key=key,
        name=name,
        tracks=tuple(PresetTrack(*row) for row in rows),
    )


BUILTIN_PRESETS: tuple[BuiltinPreset, ...] = (
    _preset(
        "general-band",
        "汎用バンド",
        (
            ("Piano", "acoustic_piano", "#4C9AFF"),
            ("Distorted Electric Guitar", "distorted_electric_guitar", "#FF7452"),
            ("Electric Bass", "electric_bass", "#7A5AF8"),
            ("Vocal", "voice", "#36B37E"),
            ("Drums", "drums", "#FFAB00"),
        ),
    ),
    _preset(
        "string-quartet",
        "弦楽四重奏",
        (
            ("Violin I / II", "violin", "#E85AAD"),
            ("Viola", "viola", "#A66DD4"),
            ("Cello", "cello", "#6554C0"),
        ),
    ),
    _preset(
        "concert-band",
        "吹奏楽",
        (
            ("Flutes", "flutes", "#00B8D9"),
            ("Oboe", "oboe", "#00A3BF"),
            ("Bassoon", "bassoon", "#008DA6"),
            ("Clarinet", "clarinet", "#36B37E"),
            ("Soprano / Alto Sax", "soprano_and_alto_sax", "#57D9A3"),
            ("Tenor Sax", "tenor_sax", "#79F2C0"),
            ("Baritone Sax", "baritone_sax", "#ABF5D1"),
            ("Trumpet", "trumpet", "#FFAB00"),
            ("French Horn", "french_horn", "#FFC400"),
            ("Trombone", "trombone", "#FFE380"),
            ("Tuba", "tuba", "#FF8B00"),
            ("Contrabass", "contrabass", "#6554C0"),
            ("Timpani", "timpani", "#FF7452"),
            ("Chromatic Percussion", "chromatic_percussion", "#FFBDAD"),
            ("Percussion", "drums", "#DE350B"),
        ),
    ),
    _preset(
        "orchestra",
        "オーケストラ",
        (
            ("Flutes", "flutes", "#00B8D9"),
            ("Oboe", "oboe", "#00A3BF"),
            ("Clarinet", "clarinet", "#36B37E"),
            ("Bassoon", "bassoon", "#008DA6"),
            ("French Horn", "french_horn", "#FFC400"),
            ("Trumpet", "trumpet", "#FFAB00"),
            ("Trombone", "trombone", "#FFE380"),
            ("Tuba", "tuba", "#FF8B00"),
            ("Violin", "violin", "#E85AAD"),
            ("Viola", "viola", "#A66DD4"),
            ("Cello", "cello", "#6554C0"),
            ("Contrabass", "contrabass", "#403294"),
            ("Orchestral Harp", "orchestral_harp", "#4C9AFF"),
            ("Timpani", "timpani", "#FF7452"),
            ("Chromatic Percussion", "chromatic_percussion", "#FFBDAD"),
            ("Percussion", "drums", "#DE350B"),
        ),
    ),
    _preset(
        "anime-song",
        "アニメソング",
        (
            ("Piano", "acoustic_piano", "#4C9AFF"),
            ("Strings", "string_ensemble", "#E85AAD"),
            ("Acoustic Guitar", "acoustic_guitar", "#FFC400"),
            ("Distorted Electric Guitar", "distorted_electric_guitar", "#FF7452"),
            ("Electric Bass", "electric_bass", "#7A5AF8"),
            ("Drums", "drums", "#DE350B"),
            ("Timpani", "timpani", "#FF8B00"),
            ("Vocal", "voice", "#36B37E"),
            ("Brass Section", "brass_section", "#FFAB00"),
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

