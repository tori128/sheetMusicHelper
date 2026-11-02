from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from uuid import UUID

from .instrument_routing import (
    BASS_FAMILY_PREFERENCES,
    BASS_INSTRUMENT_IDS,
    GUITAR_FAMILY_PREFERENCES,
    GUITAR_INSTRUMENT_IDS,
    PIANO_FAMILY_PREFERENCES,
    PIANO_INSTRUMENT_IDS,
    expand_family_track_ids,
    group_tracks_by_stem,
    ordered_track_ids,
)
from .instruments import INSTRUMENTS
from .models import Stem, Track

DRUM_INPUT_OTHER_GUIDE_GAIN = 0.2
DEFAULT_DRUM_TIMING_GUIDE_GAIN = 0.2
DRUM_TIMING_GUIDE_INPUTS = frozenset({"drums"})
PITCHED_TIMING_GUIDE_INPUTS = frozenset(
    {"bass", "vocals", "piano", "guitar", "other"}
)
ALL_TIMING_GUIDE_INPUTS = (
    DRUM_TIMING_GUIDE_INPUTS | PITCHED_TIMING_GUIDE_INPUTS
)
SeparatedTranscriptionInputName = Literal[
    "drums",
    "bass",
    "vocals",
    "piano",
    "guitar",
    "other",
]
TIMING_GUIDE_NOTE_FILTER_INPUTS = frozenset(
    {"bass", "piano", "guitar", "other"}
)
DEFAULT_PITCHED_TIMING_GUIDE_GAINS = {
    "bass": DEFAULT_DRUM_TIMING_GUIDE_GAIN,
    "vocals": DEFAULT_DRUM_TIMING_GUIDE_GAIN,
    "piano": DEFAULT_DRUM_TIMING_GUIDE_GAIN,
    "guitar": DEFAULT_DRUM_TIMING_GUIDE_GAIN,
    "other": DEFAULT_DRUM_TIMING_GUIDE_GAIN,
}


def default_pitched_timing_guide_gains() -> dict[str, float]:
    return dict(DEFAULT_PITCHED_TIMING_GUIDE_GAINS)


def active_timing_guide_inputs(
    inputs: frozenset[str],
    pitched_gains: Mapping[str, float],
) -> frozenset[str]:
    return frozenset(
        input_name
        for input_name in inputs
        if input_name in DRUM_TIMING_GUIDE_INPUTS
        or pitched_gains.get(input_name, 0.0) > 0.0
    )

StemMixer = Callable[[list[Path], Path, Callable[[], bool]], Path]
WeightedStemMixer = Callable[
    [list[Path], list[float], Path, Callable[[], bool]], Path
]
BassTimingGuideMixer = Callable[
    [Path, Path, float, Path, Callable[[], bool]], Path
]
@dataclass(frozen=True, slots=True)
class TranscriptionInput:
    audio_path: Path
    track_ids: dict[str, UUID]
    name: str
    evidence_paths: dict[str, Path]
    unmodified_audio_path: Path | None = None


@dataclass(frozen=True, slots=True)
class SeparatedInputSettings:
    automatic_instruments: bool
    drum_onset_guide: bool
    timing_guide_inputs: frozenset[str] = PITCHED_TIMING_GUIDE_INPUTS
    timing_guide_gains: Mapping[str, float] = field(
        default_factory=default_pitched_timing_guide_gains
    )
    expand_fixed_instrument_families: bool = True
    included_input_names: (
        frozenset[SeparatedTranscriptionInputName] | None
    ) = None


class TranscriptionInputBuilder:
    """Build MuScriptor inputs without owning job state or event delivery."""

    def __init__(
        self,
        stem_mixer: StemMixer,
        weighted_stem_mixer: WeightedStemMixer,
        cancelled: Callable[[], bool],
        bass_timing_guide_mixer: BassTimingGuideMixer | None = None,
    ) -> None:
        self._stem_mixer = stem_mixer
        self._weighted_stem_mixer = weighted_stem_mixer
        self._cancelled = cancelled
        self._bass_timing_guide_mixer = bass_timing_guide_mixer or (
            lambda bass, drums, gain, output, cancel: weighted_stem_mixer(
                [bass, drums],
                [1.0, gain],
                output,
                cancel,
            )
        )

    @staticmethod
    def direct(audio_path: Path, track_ids: dict[str, UUID]) -> TranscriptionInput:
        return TranscriptionInput(
            audio_path=audio_path,
            track_ids=track_ids,
            name="direct",
            evidence_paths={
                instrument_id: audio_path for instrument_id in track_ids
            },
        )

    def separated(
        self,
        stems: list[Stem],
        tracks: list[Track],
        all_track_ids: dict[str, UUID],
        settings: SeparatedInputSettings,
    ) -> list[TranscriptionInput]:
        stem_paths = {stem.type: Path(stem.cache_path) for stem in stems}
        track_ids_by_stem = self._track_ids_by_stem(
            tracks,
            all_track_ids,
            settings.automatic_instruments,
        )
        route_specs = self._route_specs(
            stem_paths,
            track_ids_by_stem,
            settings,
        )
        enabled_guide_inputs = active_timing_guide_inputs(
            settings.timing_guide_inputs,
            settings.timing_guide_gains,
        )
        inputs: list[TranscriptionInput] = []
        for input_name, track_ids, source_path in route_specs:
            if (
                settings.included_input_names is not None
                and input_name not in settings.included_input_names
            ):
                continue
            timing_guide_enabled = (
                settings.drum_onset_guide
                and input_name in enabled_guide_inputs
            )
            timing_reference_required = (
                timing_guide_enabled
                and input_name in TIMING_GUIDE_NOTE_FILTER_INPUTS
            )
            inputs.append(
                self._apply_timing_guide(
                    input_name,
                    track_ids,
                    source_path,
                    stem_paths,
                    timing_guide_enabled,
                    settings.timing_guide_gains.get(
                        input_name,
                        0.0,
                    ),
                    timing_reference_required,
                )
            )
        return inputs

    @staticmethod
    def _track_ids_by_stem(
        tracks: list[Track],
        all_track_ids: dict[str, UUID],
        automatic: bool,
    ) -> dict[str, dict[str, UUID]]:
        if not automatic:
            return group_tracks_by_stem(tracks)
        grouped = {
            "drums": {"drums": all_track_ids["drums"]},
            "bass": {
                instrument_id: all_track_ids[instrument_id]
                for instrument_id in BASS_INSTRUMENT_IDS
            },
            "vocals": {"voice": all_track_ids["voice"]},
            "other": {
                instrument.id: all_track_ids[instrument.id]
                for instrument in INSTRUMENTS
                if instrument.id != "drums"
                and instrument.id not in BASS_INSTRUMENT_IDS
                and instrument.id != "voice"
            },
        }
        return {name: ordered_track_ids(ids) for name, ids in grouped.items()}

    def _route_specs(
        self,
        stem_paths: dict[str, Path],
        track_ids_by_stem: dict[str, dict[str, UUID]],
        settings: SeparatedInputSettings,
    ) -> list[tuple[str, dict[str, UUID], Path]]:
        route_specs: list[tuple[str, dict[str, UUID], Path]] = []
        automatic = settings.automatic_instruments
        deferred_track_ids: dict[str, UUID] = {}

        def route_or_defer(
            name: str,
            track_ids: dict[str, UUID],
        ) -> None:
            if not track_ids:
                return
            source_path = stem_paths.get(name)
            if source_path is None:
                deferred_track_ids.update(track_ids)
                return
            route_specs.append((name, track_ids, source_path))

        route_or_defer("drums", track_ids_by_stem.get("drums", {}))

        bass_track_ids = self._family_tracks(
            track_ids_by_stem.get("bass", {}),
            BASS_FAMILY_PREFERENCES,
            automatic,
            settings.expand_fixed_instrument_families,
        )
        route_or_defer("bass", bass_track_ids)

        other_track_ids = track_ids_by_stem.get("other", {})
        selected_piano = {
            instrument_id: track_id
            for instrument_id, track_id in other_track_ids.items()
            if instrument_id in PIANO_INSTRUMENT_IDS
        }
        piano_track_ids = self._family_tracks(
            selected_piano,
            PIANO_FAMILY_PREFERENCES,
            automatic,
            settings.expand_fixed_instrument_families,
        )
        route_or_defer("piano", piano_track_ids)

        selected_guitar = {
            instrument_id: track_id
            for instrument_id, track_id in other_track_ids.items()
            if instrument_id in GUITAR_INSTRUMENT_IDS
        }
        guitar_track_ids = self._family_tracks(
            selected_guitar,
            GUITAR_FAMILY_PREFERENCES,
            automatic,
            settings.expand_fixed_instrument_families,
        )
        route_or_defer("guitar", guitar_track_ids)

        route_or_defer("vocals", track_ids_by_stem.get("vocals", {}))

        remainder_track_ids = {
            instrument_id: track_id
            for instrument_id, track_id in other_track_ids.items()
            if instrument_id not in PIANO_INSTRUMENT_IDS
            and instrument_id not in GUITAR_INSTRUMENT_IDS
        }
        remainder_track_ids.update(deferred_track_ids)
        fallback_audio = stem_paths.get("other")
        if fallback_audio is None:
            fallback_audio = next(iter(stem_paths.values()), None)
        if fallback_audio is None:
            return route_specs
        sources = [fallback_audio]
        unclaimed: list[str] = []
        if not piano_track_ids and "piano" in stem_paths:
            sources.append(stem_paths["piano"])
            unclaimed.append("piano")
        if not guitar_track_ids and "guitar" in stem_paths:
            sources.append(stem_paths["guitar"])
            unclaimed.append("guitar")
        remainder_audio = sources[0]
        if remainder_track_ids and len(sources) > 1:
            remainder_audio = self._stem_mixer(
                sources,
                fallback_audio.with_name(
                    f"other-with-{'-'.join(unclaimed)}.wav"
                ),
                self._cancelled,
            )
        if remainder_track_ids:
            route_specs.append(
                ("other", remainder_track_ids, remainder_audio)
            )
        return route_specs

    @staticmethod
    def _family_tracks(
        selected: dict[str, UUID],
        preferences: dict[str, tuple[str, ...]],
        automatic: bool,
        expand_fixed: bool,
    ) -> dict[str, UUID]:
        return (
            selected
            if automatic or not expand_fixed
            else expand_family_track_ids(selected, preferences)
        )

    def _apply_timing_guide(
        self,
        input_name: str,
        track_ids: dict[str, UUID],
        source_path: Path,
        stem_paths: dict[str, Path],
        enabled: bool,
        pitched_guide_gain: float,
        compare_with_unmodified: bool,
    ) -> TranscriptionInput:
        audio_path = source_path
        if enabled:
            if input_name == "bass" and "drums" in stem_paths:
                audio_path = self._bass_timing_guide_mixer(
                    source_path,
                    stem_paths["drums"],
                    pitched_guide_gain,
                    source_path.with_name(
                        f"{source_path.stem}-with-highpassed-drums-g"
                        f"{round(pitched_guide_gain * 100)}.wav"
                    ),
                    self._cancelled,
                )
            else:
                guide: tuple[Path, float, str] | None
                if input_name == "drums" and "other" in stem_paths:
                    guide = (
                        stem_paths["other"],
                        DRUM_INPUT_OTHER_GUIDE_GAIN,
                        "other",
                    )
                elif input_name in {
                    "vocals",
                    "piano",
                    "guitar",
                    "other",
                } and "drums" in stem_paths:
                    guide = (
                        stem_paths["drums"],
                        pitched_guide_gain,
                        "drums",
                    )
                else:
                    guide = None
                if guide is not None:
                    guide_path, gain, guide_name = guide
                    audio_path = self._weighted_stem_mixer(
                        [source_path, guide_path],
                        [1.0, gain],
                        source_path.with_name(
                            f"{source_path.stem}-with-{guide_name}-g"
                            f"{round(gain * 100)}.wav"
                        ),
                        self._cancelled,
                    )
        return TranscriptionInput(
            audio_path=audio_path,
            track_ids=track_ids,
            name=input_name,
            evidence_paths={instrument_id: source_path for instrument_id in track_ids},
            unmodified_audio_path=(
                source_path
                if compare_with_unmodified and audio_path != source_path
                else None
            ),
        )
