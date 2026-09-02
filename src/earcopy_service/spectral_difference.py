from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path

import librosa
import numpy

ANALYSIS_SAMPLE_RATE = 22_050
HOP_LENGTH = 256
MINIMUM_FREQUENCY_HZ = 40.0
MAXIMUM_FREQUENCY_HZ = 8_000.0
CQT_BINS_PER_OCTAVE = 12
CQT_BIN_COUNT = math.ceil(
    CQT_BINS_PER_OCTAVE
    * math.log2(MAXIMUM_FREQUENCY_HZ / MINIMUM_FREQUENCY_HZ)
)
SILENCE_FLOOR_DB = -50.0
SILENCE_POWER_RATIO = 10 ** (SILENCE_FLOOR_DB / 10)


@dataclass(frozen=True, slots=True)
class SpectralDifferenceInterval:
    start_sec: float
    end_sec: float
    measure_number: int
    beat_in_measure: int
    value: float


@dataclass(frozen=True, slots=True)
class SpectralDifferenceResult:
    intervals: list[SpectralDifferenceInterval]
    minimum: float
    maximum: float


def _load_mono(path: Path) -> numpy.ndarray:
    if not path.is_file():
        raise ValueError(f"比較対象の音声ファイルが見つかりません: {path}")
    audio, _ = librosa.load(
        path,
        sr=ANALYSIS_SAMPLE_RATE,
        mono=True,
        dtype=numpy.float32,
    )
    return numpy.asarray(audio, dtype=numpy.float32)


def _mix_sources(paths: list[Path]) -> numpy.ndarray:
    if not paths:
        raise ValueError("比較対象の原音が指定されていません")
    sources = [_load_mono(path) for path in paths]
    sample_count = max((len(source) for source in sources), default=0)
    mixed = numpy.zeros(sample_count, dtype=numpy.float32)
    for source in sources:
        mixed[: len(source)] += source
    mixed /= max(1, len(sources))
    return mixed


def _align_source_to_timeline(
    source: numpy.ndarray,
    *,
    timeline_offset_sec: float,
    sample_count: int,
) -> numpy.ndarray:
    aligned = numpy.zeros(sample_count, dtype=numpy.float32)
    timeline_start = round(timeline_offset_sec * ANALYSIS_SAMPLE_RATE)
    source_start = max(0, -timeline_start)
    destination_start = max(0, timeline_start)
    copy_count = min(
        len(source) - source_start,
        sample_count - destination_start,
    )
    if copy_count > 0:
        aligned[destination_start : destination_start + copy_count] = source[
            source_start : source_start + copy_count
        ]
    return aligned


def _fit_to_duration(audio: numpy.ndarray, sample_count: int) -> numpy.ndarray:
    fitted = numpy.zeros(sample_count, dtype=numpy.float32)
    copy_count = min(len(audio), sample_count)
    if copy_count > 0:
        fitted[:copy_count] = audio[:copy_count]
    return fitted


def _constant_q_power_spectrogram(audio: numpy.ndarray) -> numpy.ndarray:
    transform = librosa.cqt(
        audio,
        sr=ANALYSIS_SAMPLE_RATE,
        hop_length=HOP_LENGTH,
        fmin=MINIMUM_FREQUENCY_HZ,
        n_bins=CQT_BIN_COUNT,
        bins_per_octave=CQT_BINS_PER_OCTAVE,
        tuning=0.0,
        pad_mode="constant",
    )
    return numpy.square(numpy.abs(transform), dtype=numpy.float32)


def _beat_boundaries(
    *,
    duration_sec: float,
    bpm: float,
    beat_offset_sec: float,
    numerator: int,
    denominator: int,
) -> list[tuple[float, float, int, int]]:
    beat_duration_sec = (60.0 / bpm) * (4.0 / denominator)
    first_beat_index = max(
        0,
        math.ceil((0.0 - beat_offset_sec) / beat_duration_sec - 1e-9),
    )
    boundaries: list[tuple[float, float, int, int]] = []
    beat_index = first_beat_index
    while True:
        start_sec = beat_offset_sec + beat_index * beat_duration_sec
        if start_sec >= duration_sec - 1e-9:
            break
        end_sec = min(duration_sec, start_sec + beat_duration_sec)
        if end_sec > 0:
            normalized_start = max(0.0, start_sec)
            measure_number = math.floor(beat_index / numerator) + 1
            beat_in_measure = beat_index % numerator + 1
            boundaries.append(
                (
                    normalized_start,
                    end_sec,
                    measure_number,
                    beat_in_measure,
                )
            )
        beat_index += 1
    return boundaries


def _power_alignment_scale(
    source_spectrogram: numpy.ndarray,
    synthesized_spectrogram: numpy.ndarray,
    *,
    source_silence_power: float,
    synthesized_silence_power: float,
) -> float:
    source_power = numpy.sum(source_spectrogram, axis=0)
    synthesized_power = numpy.sum(synthesized_spectrogram, axis=0)
    active = (source_power > source_silence_power) & (
        synthesized_power > synthesized_silence_power
    )
    if not numpy.any(active):
        return 1.0
    return float(numpy.median(source_power[active] / synthesized_power[active]))


def _activity(power: numpy.ndarray, reference_power: float) -> numpy.ndarray:
    if reference_power <= 0:
        return numpy.zeros_like(power, dtype=numpy.float32)
    power_ratio = power / reference_power
    activity = numpy.zeros_like(power_ratio, dtype=numpy.float32)
    audible = power_ratio > SILENCE_POWER_RATIO
    activity[audible] = numpy.clip(
        (
            10.0 * numpy.log10(power_ratio[audible])
            - SILENCE_FLOOR_DB
        )
        / -SILENCE_FLOOR_DB,
        0.0,
        1.0,
    )
    return activity


def _spectral_difference(
    source: numpy.ndarray,
    synthesized: numpy.ndarray,
    *,
    reference_power: float,
) -> numpy.ndarray:
    source_power = numpy.sum(source, axis=0)
    synthesized_power = numpy.sum(synthesized, axis=0)
    if reference_power <= 0:
        return numpy.zeros(source.shape[1], dtype=numpy.float32)
    source_activity = _activity(source_power, reference_power)
    synthesized_activity = _activity(synthesized_power, reference_power)
    source_distribution = numpy.divide(
        source,
        source_power,
        out=numpy.zeros_like(source),
        where=source_power > 0,
    )
    synthesized_distribution = numpy.divide(
        synthesized,
        synthesized_power,
        out=numpy.zeros_like(synthesized),
        where=synthesized_power > 0,
    )
    frequency_distance = numpy.sqrt(
        0.5
        * numpy.sum(
            (
                numpy.sqrt(source_distribution)
                - numpy.sqrt(synthesized_distribution)
            )
            ** 2,
            axis=0,
        )
    )
    difference = numpy.abs(
        source_activity - synthesized_activity
    ) + numpy.minimum(source_activity, synthesized_activity) * frequency_distance
    return numpy.asarray(numpy.clip(difference, 0.0, 1.0), dtype=numpy.float32)


def _interval_differences(
    frame_differences: numpy.ndarray,
    boundaries: list[tuple[float, float, int, int]],
) -> list[float]:
    frame_times = librosa.frames_to_time(
        numpy.arange(len(frame_differences)),
        sr=ANALYSIS_SAMPLE_RATE,
        hop_length=HOP_LENGTH,
    )
    values: list[float] = []
    for start_sec, end_sec, _, _ in boundaries:
        selected = (frame_times >= start_sec) & (frame_times < end_sec)
        if not numpy.any(selected):
            values.append(0.0)
            continue
        interval = frame_differences[selected]
        values.append(float(numpy.sqrt(numpy.mean(numpy.square(interval)))))
    return values


def calculate_spectral_difference(
    source_paths: list[Path],
    synthesized_path: Path,
    *,
    duration_sec: float,
    timeline_offset_sec: float,
    bpm: float,
    beat_offset_sec: float,
    numerator: int,
    denominator: int,
) -> SpectralDifferenceResult:
    if not math.isfinite(duration_sec) or duration_sec <= 0:
        raise ValueError("比較時間は0秒より大きい有限値である必要があります")
    if not math.isfinite(timeline_offset_sec):
        raise ValueError("原音のタイムラインオフセットは有限値である必要があります")
    if not math.isfinite(bpm) or bpm <= 0:
        raise ValueError("BPMは0より大きい有限値である必要があります")
    if not math.isfinite(beat_offset_sec):
        raise ValueError("拍位相は有限値である必要があります")
    if numerator < 1 or denominator not in {2, 4, 8, 16}:
        raise ValueError("拍子が不正です")

    sample_count = max(1, round(duration_sec * ANALYSIS_SAMPLE_RATE))
    source = _align_source_to_timeline(
        _mix_sources(source_paths),
        timeline_offset_sec=timeline_offset_sec,
        sample_count=sample_count,
    )
    synthesized = _fit_to_duration(
        _load_mono(synthesized_path),
        sample_count,
    )
    boundaries = _beat_boundaries(
        duration_sec=duration_sec,
        bpm=bpm,
        beat_offset_sec=beat_offset_sec,
        numerator=numerator,
        denominator=denominator,
    )
    if not boundaries:
        raise ValueError("比較対象の拍区間がありません")

    source_spectrogram = _constant_q_power_spectrogram(source)
    synthesized_spectrogram = _constant_q_power_spectrogram(synthesized)
    frame_count = min(
        source_spectrogram.shape[1],
        synthesized_spectrogram.shape[1],
    )
    source_spectrogram = source_spectrogram[:, :frame_count]
    synthesized_spectrogram = synthesized_spectrogram[:, :frame_count]
    source_maximum_power = float(
        numpy.max(numpy.sum(source_spectrogram, axis=0), initial=0.0)
    )
    synthesized_maximum_power = float(
        numpy.max(numpy.sum(synthesized_spectrogram, axis=0), initial=0.0)
    )
    source_silence_power = source_maximum_power * SILENCE_POWER_RATIO
    synthesized_silence_power = (
        synthesized_maximum_power * SILENCE_POWER_RATIO
    )
    synthesized_power_scale = _power_alignment_scale(
        source_spectrogram,
        synthesized_spectrogram,
        source_silence_power=source_silence_power,
        synthesized_silence_power=synthesized_silence_power,
    )
    synthesized_spectrogram *= synthesized_power_scale
    synthesized_silence_power *= synthesized_power_scale
    reference_power = max(
        source_maximum_power,
        synthesized_maximum_power * synthesized_power_scale,
    )

    frame_differences = _spectral_difference(
        source_spectrogram,
        synthesized_spectrogram,
        reference_power=reference_power,
    )
    interval_values = _interval_differences(frame_differences, boundaries)
    intervals = [
        SpectralDifferenceInterval(
            start_sec=start_sec,
            end_sec=end_sec,
            measure_number=measure_number,
            beat_in_measure=beat_in_measure,
            value=value,
        )
        for (
            start_sec,
            end_sec,
            measure_number,
            beat_in_measure,
        ), value in zip(
            boundaries,
            interval_values,
            strict=True,
        )
    ]
    values = [interval.value for interval in intervals]
    return SpectralDifferenceResult(
        intervals=intervals,
        minimum=min(values),
        maximum=max(values),
    )
