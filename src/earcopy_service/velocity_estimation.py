from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .instrument_routing import (
    BASS_INSTRUMENT_IDS,
    GUITAR_INSTRUMENT_IDS,
    PIANO_INSTRUMENT_IDS,
)
from .models import Note, Stem

AMPLITUDE_FRAME_DURATION_SEC = 0.02
NOTE_ONSET_ANALYSIS_DURATION_SEC = 0.2
MINIMUM_VELOCITY_DBFS = -60.0
MAXIMUM_VELOCITY_DBFS = -6.0
TRANSCRIPTION_VELOCITY = 100
SeparatedStemType = Literal[
    "drums",
    "bass",
    "vocals",
    "piano",
    "guitar",
    "other",
]


@dataclass(frozen=True, slots=True)
class StemAmplitudeEnvelope:
    frame_duration_sec: float
    rms_values: Any

    def maximum_rms(self, start_sec: float, end_sec: float) -> float:
        if len(self.rms_values) == 0:
            return 0.0
        analysis_end_sec = min(
            end_sec,
            start_sec + NOTE_ONSET_ANALYSIS_DURATION_SEC,
        )
        if analysis_end_sec <= start_sec:
            analysis_end_sec = start_sec + self.frame_duration_sec
        first_frame = max(0, math.floor(start_sec / self.frame_duration_sec))
        last_frame = max(
            first_frame + 1,
            math.ceil(analysis_end_sec / self.frame_duration_sec),
        )
        if first_frame >= len(self.rms_values):
            return 0.0
        return float(
            self.rms_values[
                first_frame : min(last_frame, len(self.rms_values))
            ].max(initial=0.0)
        )


@dataclass(frozen=True, slots=True)
class VelocityAssignmentResult:
    notes: list[Note]
    measured_count: int
    unavailable_paths: tuple[Path, ...]


def separated_stem_type_for_instrument(
    instrument_id: str,
) -> SeparatedStemType:
    if instrument_id == "drums":
        return "drums"
    if instrument_id in BASS_INSTRUMENT_IDS:
        return "bass"
    if instrument_id == "voice":
        return "vocals"
    if instrument_id in PIANO_INSTRUMENT_IDS:
        return "piano"
    if instrument_id in GUITAR_INSTRUMENT_IDS:
        return "guitar"
    return "other"


def separated_stem_evidence_paths(
    notes: list[Note],
    stems: list[Stem],
) -> dict[str, Path]:
    path_by_type = {stem.type: Path(stem.cache_path) for stem in stems}
    return {
        instrument_id: path_by_type[stem_type]
        for instrument_id in dict.fromkeys(
            note.source_instrument_id for note in notes
        )
        if (stem_type := separated_stem_type_for_instrument(instrument_id))
        in path_by_type
    }


def apply_stem_amplitude_velocity_setting(
    notes: list[Note],
    stems: list[Stem],
    enabled: bool,
) -> VelocityAssignmentResult:
    if not enabled:
        return VelocityAssignmentResult(
            notes=[
                note.model_copy(update={"velocity": TRANSCRIPTION_VELOCITY})
                for note in notes
            ],
            measured_count=0,
            unavailable_paths=(),
        )
    evidence_paths = separated_stem_evidence_paths(notes, stems)
    missing_instruments = sorted(
        {
            note.source_instrument_id
            for note in notes
            if note.source_instrument_id not in evidence_paths
        }
    )
    if missing_instruments:
        raise ValueError(
            "対応する分離後音源がありません: "
            + ", ".join(missing_instruments)
        )
    return assign_velocities_from_stem_amplitude(
        notes,
        evidence_paths,
    )


def velocity_from_rms(rms: float) -> int:
    if not math.isfinite(rms) or rms <= 0.0:
        return 1
    dbfs = 20.0 * math.log10(rms)
    ratio = min(
        1.0,
        max(
            0.0,
            (dbfs - MINIMUM_VELOCITY_DBFS)
            / (MAXIMUM_VELOCITY_DBFS - MINIMUM_VELOCITY_DBFS),
        ),
    )
    return min(127, max(1, math.floor(1.0 + ratio * 126.0 + 0.5)))


def load_stem_amplitude_envelope(path: Path) -> StemAmplitudeEnvelope:
    import numpy
    import soundfile

    rms_batches: list[Any] = []
    with soundfile.SoundFile(path) as source:
        frame_length = max(
            1,
            round(source.samplerate * AMPLITUDE_FRAME_DURATION_SEC),
        )
        pending = numpy.empty((0, source.channels), dtype=numpy.float32)
        while True:
            block = source.read(
                frames=frame_length * 500,
                dtype="float32",
                always_2d=True,
            )
            if block.size == 0:
                break
            samples = (
                numpy.concatenate((pending, block), axis=0)
                if pending.size
                else block
            )
            complete_sample_count = (
                len(samples) // frame_length * frame_length
            )
            if complete_sample_count > 0:
                frames = samples[:complete_sample_count].reshape(
                    -1,
                    frame_length,
                    source.channels,
                )
                mean_squares = numpy.mean(
                    numpy.square(frames, dtype=numpy.float64),
                    axis=(1, 2),
                )
                rms_batches.append(
                    numpy.sqrt(mean_squares).astype(numpy.float32)
                )
            pending = samples[complete_sample_count:].copy()
        if pending.size:
            rms_batches.append(
                numpy.asarray(
                    [
                        math.sqrt(
                            float(
                                numpy.mean(
                                    numpy.square(
                                        pending,
                                        dtype=numpy.float64,
                                    )
                                )
                            )
                        )
                    ],
                    dtype=numpy.float32,
                )
            )
        rms_values = (
            numpy.concatenate(rms_batches)
            if rms_batches
            else numpy.empty(0, dtype=numpy.float32)
        )
        return StemAmplitudeEnvelope(
            frame_duration_sec=frame_length / source.samplerate,
            rms_values=rms_values,
        )


def assign_velocities_from_stem_amplitude(
    notes: list[Note],
    evidence_paths: Mapping[str, Path],
    envelope_cache: dict[Path, StemAmplitudeEnvelope | None] | None = None,
) -> VelocityAssignmentResult:
    cache = envelope_cache if envelope_cache is not None else {}
    unique_paths = tuple(dict.fromkeys(evidence_paths.values()))
    fallback_path = unique_paths[0] if len(unique_paths) == 1 else None
    unavailable_paths: set[Path] = set()
    measured_count = 0
    result: list[Note] = []

    for note in notes:
        path = evidence_paths.get(note.source_instrument_id, fallback_path)
        if path is None:
            result.append(note)
            continue
        if path not in cache:
            try:
                cache[path] = load_stem_amplitude_envelope(path)
            except (OSError, RuntimeError, ValueError):
                cache[path] = None
        envelope = cache[path]
        if envelope is None:
            unavailable_paths.add(path)
            result.append(note)
            continue
        rms = envelope.maximum_rms(note.raw_start_sec, note.raw_end_sec)
        result.append(
            note.model_copy(update={"velocity": velocity_from_rms(rms)})
        )
        measured_count += 1

    return VelocityAssignmentResult(
        notes=result,
        measured_count=measured_count,
        unavailable_paths=tuple(sorted(unavailable_paths)),
    )
