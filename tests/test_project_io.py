import json
from datetime import UTC, datetime

import pytest

from earcopy_service.models import (
    Note,
    ScoreTrackSettings,
    Transcription,
    TranscriptionInputResult,
)
from earcopy_service.presets import PRESET_BY_KEY, create_project
from earcopy_service.project_io import load_project, save_project


def test_project_round_trip_uses_camel_case_schema(tmp_path) -> None:
    project = create_project("保存テスト", PRESET_BY_KEY["string-quartet"])
    project.notes = [
        Note(
            sourceInstrumentId="violin",
            trackId=project.tracks[0].id,
            pitch=72,
            rawStartSec=0.5,
            rawEndSec=1.0,
            startSec=0.5,
            endSec=1.0,
        )
    ]
    project.transcription = Transcription(
        mode="separated",
        transcriptionProfile="high_accuracy",
        instrumentSelectionMode="fixed",
        presetId=PRESET_BY_KEY["string-quartet"].id,
        modelProfileId="00000000-0000-0000-0000-000000000001",
        modelSha256="b" * 64,
        backend="CPU",
        drumOnsetGuide=True,
        timingGuideNoteFilter=True,
        velocityFromStemAmplitude=True,
        completedAt=datetime(2026, 8, 18, tzinfo=UTC),
        inputResults=[
            TranscriptionInputResult(
                inputName="other",
                role="primary",
                transcriptionPass="drums_added_audio",
                notes=project.notes,
            ),
        ],
    )
    path = tmp_path / "song.ecaproj"

    save_project(project, path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    loaded = load_project(path)

    assert raw["formatVersion"] == 5
    assert raw["projectId"] == str(project.project_id)
    assert raw["notes"][0]["trackId"] == str(project.tracks[0].id)
    assert raw["transcription"]["inputResults"][0]["role"] == "primary"
    assert loaded == project


def test_project_round_trip_preserves_track_playback_volume(tmp_path) -> None:
    project = create_project("音量保存", PRESET_BY_KEY["string-quartet"])
    project.tracks[0].playback_volume = 42
    path = tmp_path / "track-volume.ecaproj"

    save_project(project, path)
    loaded = load_project(path)

    assert loaded.tracks[0].playback_volume == 42
    assert loaded.model_dump(by_alias=True, mode="json")["tracks"][0][
        "playbackVolume"
    ] == 42


def test_load_project_rejects_format_version_4(tmp_path) -> None:
    project = create_project("異なる保存形式", PRESET_BY_KEY["string-quartet"])
    raw = project.model_dump(mode="json", by_alias=True)
    raw["formatVersion"] = 4
    path = tmp_path / "format-version-4.ecaproj"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="formatVersion"):
        load_project(path)


def test_load_project_rejects_unknown_format_version(tmp_path) -> None:
    project = create_project("未対応の保存形式", PRESET_BY_KEY["string-quartet"])
    raw = project.model_dump(mode="json", by_alias=True)
    raw["formatVersion"] = 99
    path = tmp_path / "format-version-99.ecaproj"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="formatVersion"):
        load_project(path)


def test_load_project_preserves_selected_vocal_playback_program(tmp_path) -> None:
    project = create_project("ボーカル音色", PRESET_BY_KEY["general-band"])
    raw = project.model_dump(mode="json", by_alias=True, exclude_none=True)
    vocal = next(
        track for track in raw["tracks"] if track["instrumentId"] == "voice"
    )
    vocal["gmProgram"] = 52
    path = tmp_path / "vocal.ecaproj"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    loaded = load_project(path)
    loaded_vocal = next(
        track for track in loaded.tracks if track.instrument_id == "voice"
    )

    assert loaded_vocal.display_name == "Vocal"
    assert loaded_vocal.gm_program == 52


def test_project_round_trip_preserves_score_settings(tmp_path) -> None:
    project = create_project("Score settings", PRESET_BY_KEY["string-quartet"])
    violin = project.tracks[0]
    project.score.composer = "Composer"
    project.score.key_fifths = 2
    project.score.track_settings[str(violin.id)] = ScoreTrackSettings(
        clef="treble",
        transpositionSemitones=2,
    )
    path = tmp_path / "score-settings.ecaproj"

    save_project(project, path)
    loaded = load_project(path)

    assert loaded.score.composer == "Composer"
    assert loaded.score.key_fifths == 2
    assert loaded.score.track_settings[str(violin.id)] == ScoreTrackSettings(
        clef="treble",
        transpositionSemitones=2,
    )
