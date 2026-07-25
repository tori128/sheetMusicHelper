from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class CacheEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    size_bytes: int = Field(alias="sizeBytes")
    modified_at: datetime = Field(alias="modifiedAt")
    kind: str


def _entry_statistics(path: Path) -> tuple[int, float]:
    if path.is_file():
        information = path.stat()
        return information.st_size, information.st_mtime
    size = 0
    modified = path.stat().st_mtime
    for child in path.rglob("*"):
        if child.is_file():
            information = child.stat()
            size += information.st_size
            modified = max(modified, information.st_mtime)
    return size, modified


def list_cache_entries(cache_root: Path) -> list[CacheEntry]:
    if not cache_root.exists():
        return []
    entries: list[CacheEntry] = []
    for category in sorted(cache_root.iterdir(), key=lambda path: path.name):
        if not category.is_dir():
            continue
        for path in sorted(category.iterdir(), key=lambda item: item.name):
            size, modified = _entry_statistics(path)
            entries.append(
                CacheEntry(
                    id=f"{category.name}/{path.name}",
                    sizeBytes=size,
                    modifiedAt=datetime.fromtimestamp(modified, timezone.utc),
                    kind=category.name,
                )
            )
    return sorted(entries, key=lambda entry: entry.modified_at, reverse=True)


def delete_cache_entry(cache_root: Path, entry_id: str) -> None:
    parts = Path(entry_id).parts
    if (
        len(parts) != 2
        or any(part in {"", ".", ".."} for part in parts)
        or any("/" in part or "\\" in part for part in parts)
    ):
        raise ValueError("キャッシュ識別子が不正です")
    root = cache_root.resolve()
    target = (root / parts[0] / parts[1]).resolve()
    if target.parent.parent != root:
        raise ValueError("キャッシュ識別子が不正です")
    if not target.exists():
        raise ValueError("キャッシュが見つかりません")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
