from pathlib import Path

from earcopy_service.models import Stem
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.transcription_inputs import (
    SeparatedInputSettings,
    PITCHED_TIMING_GUIDE_INPUTS,
    TranscriptionInputBuilder,
)


def _stems(tmp_path: Path) -> list[Stem]:
    return [
        Stem(
            type=name,
            cachePath=str(tmp_path / f"{name}.wav"),
            sha256="a" * 64,
        )
        for name in ("drums", "bass", "vocals", "other", "piano", "guitar")
    ]


def test_timing_guide_scope_can_exclude_the_drum_input(tmp_path: Path) -> None:
    project = create_project("scope", PRESET_BY_KEY["anime-song"])
    mixed: list[str] = []

    def weighted_mix(_sources, _gains, output, _cancel):
        mixed.append(output.name)
        return output

    builder = TranscriptionInputBuilder(
        lambda _sources, output, _cancel: output,
        weighted_mix,
        lambda: False,
    )
    inputs = builder.separated(
        _stems(tmp_path),
        project.tracks,
        {track.instrument_id: track.id for track in project.tracks},
        SeparatedInputSettings(
            automatic_instruments=False,
            drum_onset_guide=True,
            timing_guide_inputs=PITCHED_TIMING_GUIDE_INPUTS,
        ),
    )
    by_name = {item.name: item for item in inputs}

    assert inputs[0].name == "drums"
    assert inputs[0].audio_path.name == "drums.wav"
    assert "drums-with-other-g20.wav" not in mixed
    assert "bass-with-highpassed-drums-g20.wav" in mixed
    assert next(item for item in inputs if item.name == "bass").audio_path.name == (
        "bass-with-highpassed-drums-g20.wav"
    )
    assert "piano-with-drums-g20.wav" in mixed
    assert "guitar-with-drums-g20.wav" in mixed
    assert "vocals-with-drums-g20.wav" in mixed
    assert "other-with-drums-g20.wav" in mixed
    assert by_name["bass"].unmodified_audio_path == tmp_path / "bass.wav"
    assert by_name["piano"].unmodified_audio_path == (
        tmp_path / "piano.wav"
    )
    assert by_name["other"].audio_path == tmp_path / "other-with-drums-g20.wav"
    assert by_name["other"].unmodified_audio_path == tmp_path / "other.wav"
    assert by_name["vocals"].unmodified_audio_path is None
    assert by_name["guitar"].unmodified_audio_path == tmp_path / "guitar.wav"


def test_timing_references_are_collected_independently_of_filter_state(
    tmp_path: Path,
) -> None:
    project = create_project("references", PRESET_BY_KEY["anime-song"])
    builder = TranscriptionInputBuilder(
        lambda _sources, output, _cancel: output,
        lambda _sources, _gains, output, _cancel: output,
        lambda: False,
    )

    inputs = builder.separated(
        _stems(tmp_path),
        project.tracks,
        {track.instrument_id: track.id for track in project.tracks},
        SeparatedInputSettings(
            automatic_instruments=False,
            drum_onset_guide=True,
        ),
    )
    by_name = {item.name: item for item in inputs}

    assert by_name["bass"].unmodified_audio_path == tmp_path / "bass.wav"
    assert by_name["piano"].unmodified_audio_path == tmp_path / "piano.wav"
    assert by_name["guitar"].unmodified_audio_path == tmp_path / "guitar.wav"
    assert by_name["other"].unmodified_audio_path == tmp_path / "other.wav"
    assert by_name["vocals"].unmodified_audio_path is None


def test_timing_guide_uses_part_specific_gains_and_skips_zero(
    tmp_path: Path,
) -> None:
    project = create_project("gains", PRESET_BY_KEY["anime-song"])
    calls: list[tuple[tuple[float, ...], str]] = []

    def weighted_mix(_sources, gains, output, _cancel):
        calls.append((tuple(gains), output.name))
        return output

    builder = TranscriptionInputBuilder(
        lambda _sources, output, _cancel: output,
        weighted_mix,
        lambda: False,
    )
    inputs = builder.separated(
        _stems(tmp_path),
        project.tracks,
        {track.instrument_id: track.id for track in project.tracks},
        SeparatedInputSettings(
            automatic_instruments=False,
            drum_onset_guide=True,
            timing_guide_gains={
                "bass": 0.0,
                "piano": 0.1,
                "guitar": 0.2,
                "vocals": 0.05,
            },
        ),
    )
    by_name = {item.name: item for item in inputs}

    assert by_name["bass"].audio_path.name == "bass.wav"
    assert calls == [
        ((1.0, 0.1), "piano-with-drums-g10.wav"),
        ((1.0, 0.2), "guitar-with-drums-g20.wav"),
        ((1.0, 0.05), "vocals-with-drums-g5.wav"),
    ]


def test_fixed_family_expansion_can_be_disabled_for_measurement(
    tmp_path: Path,
) -> None:
    project = create_project("families", PRESET_BY_KEY["anime-song"])
    builder = TranscriptionInputBuilder(
        lambda _sources, output, _cancel: output,
        lambda _sources, _gains, output, _cancel: output,
        lambda: False,
    )
    inputs = builder.separated(
        _stems(tmp_path),
        project.tracks,
        {track.instrument_id: track.id for track in project.tracks},
        SeparatedInputSettings(
            automatic_instruments=False,
            drum_onset_guide=False,
            expand_fixed_instrument_families=False,
        ),
    )
    by_name = {item.name: item for item in inputs}

    assert list(by_name["bass"].track_ids) == ["electric_bass"]
    assert list(by_name["piano"].track_ids) == ["acoustic_piano"]
    assert list(by_name["guitar"].track_ids) == [
        "acoustic_guitar",
        "distorted_electric_guitar",
    ]


def test_unselected_piano_and_guitar_audio_is_included_in_other_input(
    tmp_path: Path,
) -> None:
    project = create_project("strings", PRESET_BY_KEY["string-quartet"])
    mixes: list[tuple[tuple[str, ...], str]] = []

    def mix(sources, output, _cancel):
        mixes.append((tuple(path.name for path in sources), output.name))
        return output

    builder = TranscriptionInputBuilder(
        mix,
        lambda _sources, _gains, output, _cancel: output,
        lambda: False,
    )
    inputs = builder.separated(
        _stems(tmp_path),
        project.tracks,
        {track.instrument_id: track.id for track in project.tracks},
        SeparatedInputSettings(
            automatic_instruments=False,
            drum_onset_guide=False,
        ),
    )

    other = next(item for item in inputs if item.name == "other")
    assert other.audio_path.name == "other-with-piano-guitar.wav"
    assert mixes == [
        (
            ("other.wav", "piano.wav", "guitar.wav"),
            "other-with-piano-guitar.wav",
        )
    ]


def test_included_input_names_excludes_unrelated_stems(tmp_path: Path) -> None:
    project = create_project("other only", PRESET_BY_KEY["anime-song"])
    weighted_mixes: list[str] = []

    def weighted_mix(_sources, _gains, output, _cancel):
        weighted_mixes.append(output.name)
        return output

    builder = TranscriptionInputBuilder(
        lambda _sources, output, _cancel: output,
        weighted_mix,
        lambda: False,
    )
    inputs = builder.separated(
        _stems(tmp_path),
        project.tracks,
        {track.instrument_id: track.id for track in project.tracks},
        SeparatedInputSettings(
            automatic_instruments=False,
            drum_onset_guide=True,
            included_input_names=frozenset({"other"}),
        ),
    )

    assert [item.name for item in inputs] == ["other"]
    assert weighted_mixes == ["other-with-drums-g20.wav"]
