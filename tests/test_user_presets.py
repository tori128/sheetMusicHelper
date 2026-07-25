import pytest

from earcopy_service.user_presets import UserPresetStore, UserPresetTrack


def _track(name: str, instrument_id: str, kind: str, order: int):
    return UserPresetTrack(
        displayName=name,
        instrumentId=instrument_id,
        color="#123456",
        kind=kind,
        order=order,
    )


def test_user_preset_store_saves_and_reloads_json(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "UserData" / "presets.json")

    saved = store.save_as(
        "Custom",
        [
            _track("Piano", "acoustic_piano", "pitched", 1),
            _track("Drums", "drums", "drums", 2),
        ],
    )
    loaded = store.list()

    assert loaded == [saved]
    assert loaded[0].tracks[1].instrument_id == "drums"


def test_user_preset_rejects_duplicate_instruments(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "presets.json")

    with pytest.raises(ValueError, match="重複"):
        store.save_as(
            "Invalid",
            [
                _track("Piano 1", "acoustic_piano", "pitched", 1),
                _track("Piano 2", "acoustic_piano", "pitched", 2),
            ],
        )
