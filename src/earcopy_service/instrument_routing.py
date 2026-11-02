from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Literal
from uuid import UUID, uuid4

from .instruments import INSTRUMENTS
from .models import Note, PITCHED_MIDI_CHANNELS, Track
from .presets import TRACK_COLOR_PALETTE

StemName = Literal["drums", "bass", "vocals", "other"]

BASS_INSTRUMENT_IDS = frozenset(
    {"acoustic_bass", "electric_bass", "contrabass"}
)
PIANO_INSTRUMENT_IDS = frozenset(
    {"acoustic_piano", "electric_piano"}
)
GUITAR_INSTRUMENT_IDS = frozenset(
    {
        "acoustic_guitar",
        "clean_electric_guitar",
        "distorted_electric_guitar",
    }
)
BASS_FAMILY_PREFERENCES = {
    "acoustic_bass": ("acoustic_bass", "contrabass", "electric_bass"),
    "electric_bass": ("electric_bass", "acoustic_bass", "contrabass"),
    "contrabass": ("contrabass", "acoustic_bass", "electric_bass"),
}
PIANO_FAMILY_PREFERENCES = {
    "acoustic_piano": ("acoustic_piano", "electric_piano"),
    "electric_piano": ("electric_piano", "acoustic_piano"),
}
GUITAR_FAMILY_PREFERENCES = {
    "acoustic_guitar": (
        "acoustic_guitar",
        "clean_electric_guitar",
        "distorted_electric_guitar",
    ),
    "clean_electric_guitar": (
        "clean_electric_guitar",
        "distorted_electric_guitar",
        "acoustic_guitar",
    ),
    "distorted_electric_guitar": (
        "distorted_electric_guitar",
        "clean_electric_guitar",
        "acoustic_guitar",
    ),
}

INSTRUMENT_ORDER = {
    instrument.id: index for index, instrument in enumerate(INSTRUMENTS)
}
INSTRUMENT_BY_ID = {instrument.id: instrument for instrument in INSTRUMENTS}
MAPPED_DUPLICATE_TOLERANCE_SEC = 0.03


def ordered_track_ids(track_ids: Mapping[str, UUID]) -> dict[str, UUID]:
    return dict(
        sorted(
            track_ids.items(),
            key=lambda item: INSTRUMENT_ORDER[item[0]],
        )
    )


def group_tracks_by_stem(tracks: list[Track]) -> dict[StemName, dict[str, UUID]]:
    grouped: dict[StemName, dict[str, UUID]] = {
        "drums": {},
        "bass": {},
        "vocals": {},
        "other": {},
    }
    for track in tracks:
        instrument_id = track.instrument_id
        if track.kind == "drums":
            stem_name: StemName = "drums"
        elif instrument_id in BASS_INSTRUMENT_IDS:
            stem_name = "bass"
        elif instrument_id == "voice":
            stem_name = "vocals"
        else:
            stem_name = "other"
        grouped[stem_name][instrument_id] = track.id

    for stem_name in grouped:
        grouped[stem_name] = ordered_track_ids(grouped[stem_name])
    return grouped


def expand_family_track_ids(
    selected_track_ids: Mapping[str, UUID],
    candidate_preferences: Mapping[str, tuple[str, ...]],
) -> dict[str, UUID]:
    """Map each family candidate to the nearest selected output track."""

    selected = ordered_track_ids(selected_track_ids)
    if not selected:
        return {}
    expanded = dict(selected)
    for candidate_id in sorted(
        candidate_preferences,
        key=lambda instrument_id: INSTRUMENT_ORDER[instrument_id],
    ):
        if candidate_id in expanded:
            continue
        target_id = next(
            instrument_id
            for instrument_id in candidate_preferences[candidate_id]
            if instrument_id in selected
        )
        expanded[candidate_id] = selected[target_id]
    return expanded


def expand_selected_instrument_families(
    selected_track_ids: Mapping[str, UUID],
) -> dict[str, UUID]:
    expanded = dict(selected_track_ids)
    for family, preferences in (
        (BASS_INSTRUMENT_IDS, BASS_FAMILY_PREFERENCES),
        (PIANO_INSTRUMENT_IDS, PIANO_FAMILY_PREFERENCES),
        (GUITAR_INSTRUMENT_IDS, GUITAR_FAMILY_PREFERENCES),
    ):
        selected_family = {
            instrument_id: track_id
            for instrument_id, track_id in selected_track_ids.items()
            if instrument_id in family
        }
        for instrument_id, track_id in expand_family_track_ids(
            selected_family,
            preferences,
        ).items():
            expanded.setdefault(instrument_id, track_id)
    return expanded


def collapse_mapped_family_duplicates(
    notes: list[Note],
    selected_instrument_by_track_id: Mapping[UUID, str],
    tolerance_sec: float = MAPPED_DUPLICATE_TOLERANCE_SEC,
) -> tuple[list[Note], int]:
    """Remove only near-identical aliases mapped to the same fixed track."""

    def priority(note: Note) -> tuple[int, int, float, float, str]:
        selected_instrument = selected_instrument_by_track_id.get(note.track_id)
        return (
            0 if note.source_instrument_id == selected_instrument else 1,
            INSTRUMENT_ORDER[note.source_instrument_id],
            note.raw_start_sec,
            note.raw_end_sec,
            str(note.id),
        )

    kept: list[Note] = []
    discarded = 0
    for note in sorted(notes, key=priority):
        duplicate = any(
            candidate.track_id == note.track_id
            and candidate.pitch == note.pitch
            and candidate.source_instrument_id != note.source_instrument_id
            and abs(candidate.raw_start_sec - note.raw_start_sec) <= tolerance_sec
            and abs(candidate.raw_end_sec - note.raw_end_sec) <= tolerance_sec
            for candidate in kept
        )
        if duplicate:
            discarded += 1
        else:
            kept.append(note)
    kept.sort(
        key=lambda note: (
            note.raw_start_sec,
            note.pitch,
            INSTRUMENT_ORDER[note.source_instrument_id],
            str(note.id),
        )
    )
    return kept, discarded


def transcription_candidate_ids(
    target_ids: Mapping[str, UUID],
    input_name: str,
    tracks: list[Track],
    drum_onset_guide: bool,
) -> list[str]:
    candidates = list(target_ids)
    reject_candidates: set[str] = set()
    if drum_onset_guide and input_name in {
        "bass",
        "vocals",
        "piano",
        "guitar",
        "other",
    }:
        reject_candidates.add("drums")
    elif drum_onset_guide and input_name == "drums":
        reject_candidates.update(
            track.instrument_id
            for track in tracks
            if track.instrument_id != "drums"
        )
        if not reject_candidates:
            reject_candidates.add("acoustic_piano")
    return [
        *candidates,
        *sorted(
            reject_candidates - set(candidates),
            key=lambda instrument_id: INSTRUMENT_ORDER[instrument_id],
        ),
    ]


class InstrumentTrackRegistry:
    """Own fixed or model-selected track IDs and publish automatic tracks once."""

    def __init__(
        self,
        tracks: list[Track],
        automatic: bool,
        publish_track: Callable[[Track], None],
    ) -> None:
        self.automatic = automatic
        self.track_ids = (
            {instrument.id: uuid4() for instrument in INSTRUMENTS}
            if automatic
            else {track.instrument_id: track.id for track in tracks}
        )
        self.selected_instrument_by_track_id = {
            track.id: track.instrument_id for track in tracks
        }
        self._publish_track = publish_track
        self._published: dict[str, Track] = {}
        self._pitched_track_count = 0

    def ensure_published(self, instrument_id: str) -> bool:
        if not self.automatic or instrument_id in self._published:
            return True
        if len(self._published) >= 16:
            return False

        instrument = INSTRUMENT_BY_ID[instrument_id]
        if instrument.kind == "drums":
            midi_channel = 10
        else:
            if self._pitched_track_count >= len(PITCHED_MIDI_CHANNELS):
                return False
            midi_channel = PITCHED_MIDI_CHANNELS[self._pitched_track_count]
            self._pitched_track_count += 1

        order = len(self._published) + 1
        track = Track(
            id=self.track_ids[instrument_id],
            displayName=instrument.display_name_ja,
            instrumentId=instrument_id,
            kind=instrument.kind,
            color=TRACK_COLOR_PALETTE[order - 1],
            order=order,
            midiChannel=midi_channel,
            gmProgram=instrument.gm_program,
        )
        self._published[instrument_id] = track
        self._publish_track(track)
        return True

    @property
    def published_instrument_ids(self) -> tuple[str, ...]:
        return tuple(self._published)
