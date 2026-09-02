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
    assert loaded[0].tracks[0].gm_program == 0


def test_user_preset_store_deletes_only_the_requested_preset(tmp_path) -> None:
    store = UserPresetStore(tmp_path / "UserData" / "presets.json")
    first = store.save_as(
        "First",
        [_track("Piano", "acoustic_piano", "pitched", 1)],
    )
    second = store.save_as(
        "Second",
        [_track("Drums", "drums", "drums", 1)],
    )

    assert store.delete(first.id) is True
    assert store.list() == [second]
    assert store.delete(first.id) is False


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


def test_user_preset_accepts_only_gm_programs_in_the_instrument_group() -> None:
    selected = UserPresetTrack(
        displayName="Bright Piano",
        instrumentId="acoustic_piano",
        color="#123456",
        kind="pitched",
        order=1,
        gmProgram=1,
    )

    assert selected.gm_program == 1
    with pytest.raises(ValueError, match="使用できないGM音色"):
        UserPresetTrack(
            displayName="Invalid",
            instrumentId="acoustic_piano",
            color="#123456",
            kind="pitched",
            order=1,
            gmProgram=33,
        )


def test_user_preset_preserves_selected_vocal_program() -> None:
    track = UserPresetTrack(
        displayName="Vocal",
        instrumentId="voice",
        color="#123456",
        kind="pitched",
        order=1,
        gmProgram=52,
    )

    assert track.gm_program == 52
