from pathlib import Path

import pytest

from earcopy_service.cache_management import (
    delete_cache_entry,
    list_cache_entries,
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
