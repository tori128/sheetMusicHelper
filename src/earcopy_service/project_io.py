from __future__ import annotations

import json
from pathlib import Path
from tempfile import NamedTemporaryFile

from .models import Project


def load_project(path: Path) -> Project:
    if path.suffix.lower() != ".ecaproj":
        raise ValueError("プロジェクト拡張子は.ecaprojである必要があります")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"プロジェクトJSONが不正です: {exc}") from exc
    return Project.model_validate(data)


def save_project(project: Project, path: Path) -> None:
    if path.suffix.lower() != ".ecaproj":
        raise ValueError("プロジェクト拡張子は.ecaprojである必要があります")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = project.model_dump_json(
        by_alias=True,
        exclude_none=True,
        indent=2,
    )
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary.write(payload)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    temporary_path.replace(path)
