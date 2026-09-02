from __future__ import annotations

import numpy
import pytest
import soundfile

from earcopy_service.models import Note, Stem
from earcopy_service.velocity_estimation import (
    apply_stem_amplitude_velocity_setting,
    assign_velocities_from_stem_amplitude,
    separated_stem_evidence_paths,
    velocity_from_rms,
)


def _note(note_id, instrument_id, start_sec, end_sec, velocity=100):
    return Note(
        id=note_id,
        sourceInstrumentId=instrument_id,
        trackId="00000000-0000-0000-0000-000000000001",
        pitch=60,
        rawStartSec=start_sec,
        rawEndSec=end_sec,
        startSec=start_sec,
        endSec=end_sec,
        velocity=velocity,
    )


def test_velocity_from_rms_uses_fixed_dbfs_bounds() -> None:
    assert velocity_from_rms(0.0) == 1
    assert velocity_from_rms(10 ** (-60 / 20)) == 1
    assert velocity_from_rms(10 ** (-33 / 20)) == 64
    assert velocity_from_rms(10 ** (-6 / 20)) == 127
    assert velocity_from_rms(1.0) == 127


def test_assigns_velocity_from_each_note_onset_on_a_fixed_dbfs_scale(
    tmp_path,
) -> None:
    sample_rate = 1_000
    audio = numpy.zeros((1_000, 2), dtype=numpy.float32)
    audio[0:200] = 10 ** (-60 / 20)
    audio[400:600] = 10 ** (-33 / 20)
    audio[800:1_000] = 10 ** (-6 / 20)
    path = tmp_path / "piano.wav"
    soundfile.write(path, audio, sample_rate, subtype="FLOAT")
    notes = [
        _note("00000000-0000-0000-0000-000000000010", "acoustic_piano", 0.0, 0.2),
        _note("00000000-0000-0000-0000-000000000011", "acoustic_piano", 0.4, 0.6),
        _note("00000000-0000-0000-0000-000000000012", "acoustic_piano", 0.8, 1.0),
    ]

    result = assign_velocities_from_stem_amplitude(
        notes,
        {"acoustic_piano": path},
    )

    assert [note.velocity for note in result.notes] == [1, 64, 127]
    assert result.measured_count == 3
    assert result.unavailable_paths == ()


def test_uses_only_the_first_200_milliseconds_of_a_note(tmp_path) -> None:
    sample_rate = 1_000
    audio = numpy.full((1_000, 1), 10 ** (-60 / 20), dtype=numpy.float32)
    audio[500:1_000] = 10 ** (-6 / 20)
    path = tmp_path / "voice.wav"
    soundfile.write(path, audio, sample_rate, subtype="FLOAT")

    result = assign_velocities_from_stem_amplitude(
        [_note("00000000-0000-0000-0000-000000000020", "voice", 0.0, 1.0)],
        {"voice": path},
    )

    assert result.notes[0].velocity == 1


def test_uses_the_waveform_assigned_to_each_instrument(tmp_path) -> None:
    quiet_path = tmp_path / "bass.wav"
    loud_path = tmp_path / "piano.wav"
    soundfile.write(
        quiet_path,
        numpy.full((200, 2), 10 ** (-60 / 20), dtype=numpy.float32),
        1_000,
        subtype="FLOAT",
    )
    soundfile.write(
        loud_path,
        numpy.full((200, 2), 10 ** (-6 / 20), dtype=numpy.float32),
        1_000,
        subtype="FLOAT",
    )

    result = assign_velocities_from_stem_amplitude(
        [
            _note(
                "00000000-0000-0000-0000-000000000021",
                "electric_bass",
                0.0,
                0.2,
            ),
            _note(
                "00000000-0000-0000-0000-000000000022",
                "acoustic_piano",
                0.0,
                0.2,
            ),
        ],
        {
            "electric_bass": quiet_path,
            "acoustic_piano": loud_path,
        },
    )

    assert [note.velocity for note in result.notes] == [1, 127]


def test_preserves_backend_velocity_when_waveform_is_unavailable(tmp_path) -> None:
    path = tmp_path / "missing.wav"
    note = _note(
        "00000000-0000-0000-0000-000000000030",
        "electric_bass",
        0.0,
        0.2,
        velocity=91,
    )

    result = assign_velocities_from_stem_amplitude(
        [note],
        {"electric_bass": path},
    )

    assert result.notes == [note]
    assert result.measured_count == 0
    assert result.unavailable_paths == (path,)


def test_maps_each_instrument_family_to_its_separated_stem(tmp_path) -> None:
    stem_types = ("drums", "bass", "vocals", "piano", "guitar", "other")
    stems = [
        Stem(
            type=stem_type,
            cachePath=str(tmp_path / f"{stem_type}.wav"),
            sha256=str(index + 1) * 64,
        )
        for index, stem_type in enumerate(stem_types)
    ]
    instruments = (
        "drums",
        "electric_bass",
        "voice",
        "electric_piano",
        "clean_electric_guitar",
        "violin",
    )
    notes = [
        _note(
            f"00000000-0000-0000-0000-{index + 40:012d}",
            instrument_id,
            0.0,
            0.2,
        )
        for index, instrument_id in enumerate(instruments)
    ]

    paths = separated_stem_evidence_paths(notes, stems)

    assert {
        instrument_id: path.name for instrument_id, path in paths.items()
    } == dict(zip(instruments, (f"{stem_type}.wav" for stem_type in stem_types)))


def test_disabling_stem_amplitude_velocity_restores_transcription_velocity() -> None:
    note = _note(
        "00000000-0000-0000-0000-000000000050",
        "acoustic_piano",
        0.0,
        0.2,
        velocity=37,
    )

    result = apply_stem_amplitude_velocity_setting([note], [], False)

    assert result.notes[0].velocity == 100
    assert result.measured_count == 0


def test_enabling_stem_amplitude_velocity_requires_the_corresponding_stem() -> None:
    note = _note(
        "00000000-0000-0000-0000-000000000051",
        "acoustic_piano",
        0.0,
        0.2,
    )

    with pytest.raises(ValueError, match="acoustic_piano"):
        apply_stem_amplitude_velocity_setting([note], [], True)
