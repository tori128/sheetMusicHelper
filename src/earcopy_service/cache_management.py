from __future__ import annotations

import shutil
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


DEFAULT_CACHE_ENTRY_LIMIT = 10


class CacheEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    size_bytes: int = Field(alias="sizeBytes")
    modified_at: datetime = Field(alias="modifiedAt")
    kind: str


@dataclass(frozen=True, slots=True)
class CachePruneResult:
    deleted_entries: int
    deleted_bytes: int
    failed_entry_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _CachePath:
    id: str
    kind: str
    path: Path
    size_bytes: int
    modified_at: float


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


def _stem_cache_paths(category: Path) -> Iterable[Path]:
    for version_or_entry in sorted(category.iterdir(), key=lambda path: path.name):
        if not version_or_entry.is_dir():
            yield version_or_entry
            continue
        nested_directories = [
            child for child in version_or_entry.iterdir() if child.is_dir()
        ]
        direct_files = [
            child for child in version_or_entry.iterdir() if child.is_file()
        ]
        if nested_directories and not direct_files:
            yield from sorted(nested_directories, key=lambda path: path.name)
        else:
            yield version_or_entry


def _category_cache_paths(category: Path) -> Iterable[Path]:
    if category.name == "stems":
        yield from _stem_cache_paths(category)
        return
    yield from sorted(category.iterdir(), key=lambda path: path.name)


def _cache_paths(cache_root: Path) -> list[_CachePath]:
    if not cache_root.exists():
        return []
    entries: list[_CachePath] = []
    for category in sorted(cache_root.iterdir(), key=lambda path: path.name):
        if not category.is_dir():
            continue
        for path in _category_cache_paths(category):
            size, modified = _entry_statistics(path)
            entries.append(
                _CachePath(
                    id=path.relative_to(cache_root).as_posix(),
                    kind=category.name,
                    path=path,
                    size_bytes=size,
                    modified_at=modified,
                )
            )
    return entries


def list_cache_entries(cache_root: Path) -> list[CacheEntry]:
    return sorted(
        (
            CacheEntry(
                id=entry.id,
                sizeBytes=entry.size_bytes,
                modifiedAt=datetime.fromtimestamp(entry.modified_at, timezone.utc),
                kind=entry.kind,
            )
            for entry in _cache_paths(cache_root)
        ),
        key=lambda entry: entry.modified_at,
        reverse=True,
    )


def _validated_target(cache_root: Path, entry_id: str) -> Path:
    normalized = entry_id.replace("\\", "/")
    parts = normalized.split("/")
    if (
        len(parts) < 2
        or any(part in {"", ".", ".."} for part in parts)
        or (len(parts) > 2 and parts[0] != "stems")
        or len(parts) > 3
    ):
        raise ValueError("キャッシュ識別子が不正です")
    root = cache_root.resolve()
    target = root.joinpath(*parts).resolve()
    if not target.is_relative_to(root) or target.parent == root:
        raise ValueError("キャッシュ識別子が不正です")
    return target


def _remove_empty_parents(path: Path, cache_root: Path) -> None:
    root = cache_root.resolve()
    parent = path.parent
    while parent != root and parent.parent != root:
        try:
            parent.rmdir()
        except OSError:
            return
        parent = parent.parent


def delete_cache_entry(cache_root: Path, entry_id: str) -> None:
    target = _validated_target(cache_root, entry_id)
    if not target.exists():
        raise ValueError("キャッシュが見つかりません")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    _remove_empty_parents(target, cache_root)


def mark_cache_entry_used(path: Path) -> None:
    try:
        path.touch(exist_ok=True)
    except OSError:
        return


def prune_cache_entries(
    cache_root: Path,
    *,
    max_entries_per_kind: int = DEFAULT_CACHE_ENTRY_LIMIT,
    active_stem_version: str | None = None,
    kinds: set[str] | None = None,
    protected_paths: Iterable[Path] = (),
    protected_paths_count_toward_limit: bool = False,
) -> CachePruneResult:
    if max_entries_per_kind < 0:
        raise ValueError("キャッシュ保持件数は0以上で指定してください")
    root = cache_root.resolve()
    protected = {path.resolve(strict=False) for path in protected_paths}
    deleted_entries = 0
    deleted_bytes = 0
    failed: list[str] = []

    def remove(entry: _CachePath) -> None:
        nonlocal deleted_entries, deleted_bytes
        resolved = entry.path.resolve(strict=False)
        if resolved in protected or not resolved.is_relative_to(root):
            return
        try:
            if entry.path.is_dir():
                shutil.rmtree(entry.path)
            else:
                entry.path.unlink(missing_ok=True)
            _remove_empty_parents(entry.path, root)
        except OSError:
            failed.append(entry.id)
            return
        deleted_entries += 1
        deleted_bytes += entry.size_bytes

    if active_stem_version is not None and (kinds is None or "stems" in kinds):
        stems_root = root / "stems"
        if stems_root.is_dir():
            for version in stems_root.iterdir():
                if not version.is_dir() or version.name == active_stem_version:
                    continue
                size, modified = _entry_statistics(version)
                remove(
                    _CachePath(
                        id=f"stems/{version.name}",
                        kind="stems",
                        path=version,
                        size_bytes=size,
                        modified_at=modified,
                    )
                )

    grouped: dict[str, list[_CachePath]] = {}
    for entry in _cache_paths(root):
        if kinds is not None and entry.kind not in kinds:
            continue
        grouped.setdefault(entry.kind, []).append(entry)
    for entries in grouped.values():
        entries.sort(
            key=lambda entry: (
                (
                    entry.path.resolve(strict=False) in protected
                    if protected_paths_count_toward_limit
                    else False
                ),
                entry.modified_at,
                entry.id,
            ),
            reverse=True,
        )
        retained = 0
        for entry in entries:
            if entry.path.resolve(strict=False) in protected:
                if protected_paths_count_toward_limit:
                    retained += 1
                continue
            if retained < max_entries_per_kind:
                retained += 1
                continue
            remove(entry)

    return CachePruneResult(
        deleted_entries=deleted_entries,
        deleted_bytes=deleted_bytes,
        failed_entry_ids=tuple(failed),
    )
