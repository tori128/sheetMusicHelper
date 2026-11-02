import os
from pathlib import Path

import pytest

from earcopy_service.cache_management import (
    delete_cache_entry,
    list_cache_entries,
    prune_cache_entries,
)


def test_lists_cache_size_kind_and_identifier(tmp_path: Path) -> None:
    audio = tmp_path / "audio"
    stems = tmp_path / "stems" / "song"
    audio.mkdir()
    stems.mkdir(parents=True)
    (audio / "analysis.wav").write_bytes(b"a" * 12)
    (stems / "drums.wav").write_bytes(b"d" * 20)
    (stems / "bass.wav").write_bytes(b"b" * 30)

    entries = {entry.id: entry for entry in list_cache_entries(tmp_path)}

    assert entries["audio/analysis.wav"].size_bytes == 12
    assert entries["audio/analysis.wav"].kind == "audio"
    assert entries["stems/song"].size_bytes == 50
    assert entries["stems/song"].kind == "stems"
    assert entries["stems/song"].modified_at.tzinfo is not None


def test_deletes_only_a_direct_category_entry(tmp_path: Path) -> None:
    cached = tmp_path / "audio" / "analysis.wav"
    cached.parent.mkdir()
    cached.write_bytes(b"audio")

    delete_cache_entry(tmp_path, "audio/analysis.wav")

    assert not cached.exists()
    with pytest.raises(ValueError, match="不正"):
        delete_cache_entry(tmp_path, "../outside")
    with pytest.raises(ValueError, match="不正"):
        delete_cache_entry(tmp_path, "audio/subdirectory/file.wav")


def test_lists_and_deletes_a_stem_source_below_its_cache_version(
    tmp_path: Path,
) -> None:
    source = tmp_path / "stems" / "components-v2" / "source-hash"
    source.mkdir(parents=True)
    (source / "drums.wav").write_bytes(b"drums")

    entries = list_cache_entries(tmp_path)

    assert [entry.id for entry in entries] == [
        "stems/components-v2/source-hash"
    ]
    delete_cache_entry(tmp_path, entries[0].id)
    assert not source.exists()
    assert not source.parent.exists()


def test_prunes_each_kind_to_ten_most_recent_entries_and_old_stem_versions(
    tmp_path: Path,
) -> None:
    active_version = "components-v2"
    expected_audio: set[str] = set()
    expected_transcriptions: set[str] = set()
    expected_stems: set[str] = set()
    for index in range(12):
        audio = tmp_path / "audio" / f"audio-{index:02d}"
        audio.mkdir(parents=True)
        (audio / "analysis.wav").write_bytes(bytes([index]))
        transcription = tmp_path / "transcriptions" / f"result-{index:02d}.json.gz"
        transcription.parent.mkdir(parents=True, exist_ok=True)
        transcription.write_bytes(bytes([index]))
        stem = tmp_path / "stems" / active_version / f"source-{index:02d}"
        stem.mkdir(parents=True)
        (stem / "drums.wav").write_bytes(bytes([index]))
        modified = 1_000_000 + index
        os.utime(audio / "analysis.wav", (modified, modified))
        os.utime(transcription, (modified, modified))
        os.utime(stem, (modified, modified))
        if index >= 2:
            expected_audio.add(f"audio/audio-{index:02d}")
            expected_transcriptions.add(
                f"transcriptions/result-{index:02d}.json.gz"
            )
            expected_stems.add(
                f"stems/{active_version}/source-{index:02d}"
            )
    obsolete = tmp_path / "stems" / "components-v1" / "old-source"
    obsolete.mkdir(parents=True)
    (obsolete / "drums.wav").write_bytes(b"obsolete")
    result = prune_cache_entries(
        tmp_path,
        active_stem_version=active_version,
    )

    ids = {entry.id for entry in list_cache_entries(tmp_path)}
    assert ids == expected_audio | expected_transcriptions | expected_stems
    assert not obsolete.parent.exists()
    assert result.deleted_entries == 7
    assert result.deleted_bytes > 0
    assert result.failed_entry_ids == ()


def test_pruning_retains_a_protected_entry_outside_the_normal_limit(
    tmp_path: Path,
) -> None:
    entries: list[Path] = []
    for index in range(3):
        entry = tmp_path / "audio" / f"audio-{index}"
        entry.mkdir(parents=True)
        (entry / "analysis.wav").write_bytes(bytes([index]))
        os.utime(entry / "analysis.wav", (1_000 + index, 1_000 + index))
        entries.append(entry)

    prune_cache_entries(
        tmp_path,
        max_entries_per_kind=1,
        kinds={"audio"},
        protected_paths={entries[0]},
    )

    retained = {entry.id for entry in list_cache_entries(tmp_path)}
    assert retained == {"audio/audio-0", "audio/audio-2"}
