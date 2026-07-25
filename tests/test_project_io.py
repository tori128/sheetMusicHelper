import json

from earcopy_service.models import Note
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
    path = tmp_path / "song.ecaproj"

    save_project(project, path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    loaded = load_project(path)

    assert raw["formatVersion"] == 1
    assert raw["projectId"] == str(project.project_id)
    assert raw["notes"][0]["trackId"] == str(project.tracks[0].id)
    assert loaded == project

