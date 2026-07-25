import json
import struct

import pytest

from earcopy_service.model_profiles import ModelProfileStore
from earcopy_service.model_validation import validate_model_file

VARIANT_CONFIGS = {
    "small": {"dim": 768, "num_heads": 12, "num_layers": 14, "card": 1393},
    "medium": {"dim": 1024, "num_heads": 16, "num_layers": 24, "card": 1395},
    "large": {"dim": 1536, "num_heads": 24, "num_layers": 48, "card": 1395},
}


def _write_model(directory, variant):
    directory.mkdir(parents=True)
    header = json.dumps(
        {
            "weight": {
                "dtype": "F32",
                "shape": [1],
                "data_offsets": [0, 4],
            }
        },
        separators=(",", ":"),
    ).encode("utf-8")
    path = directory / "model.safetensors"
    variant_value = {"small": 1.0, "medium": 2.0, "large": 3.0}[variant]
    path.write_bytes(
        len(header).to_bytes(8, "little")
        + header
        + struct.pack("<f", variant_value)
    )
    (directory / "config.json").write_text(
        json.dumps(VARIANT_CONFIGS[variant]),
        encoding="utf-8",
    )
    return path


@pytest.mark.parametrize("variant", ["small", "medium", "large"])
def test_validation_accepts_all_official_model_variants(tmp_path, variant) -> None:
    model_path = _write_model(tmp_path / variant, variant)

    result = validate_model_file(model_path)

    assert result.loadable is True
    assert result.variant == variant
    assert result.tensor_count == 1
    assert result.dtypes == ["F32"]


def test_validation_rejects_variant_mismatch(tmp_path) -> None:
    model_path = _write_model(tmp_path / "model", "small")

    result = validate_model_file(model_path, expected_variant="large")

    assert result.loadable is False
    assert any("一致しません" in error for error in result.errors)


def test_profile_store_persists_multiple_model_sizes(tmp_path) -> None:
    small_path = _write_model(tmp_path / "small", "small")
    large_path = _write_model(tmp_path / "large", "large")
    store_path = tmp_path / "UserData" / "model-profiles.json"
    store = ModelProfileStore(store_path)

    small = store.register("CPU確認用", small_path, "small", "float32", "CPU")
    large = store.register("高精度用", large_path, "large", "float16", "CUDA")
    reloaded = ModelProfileStore(store_path).list()

    assert small.variant == "small"
    assert large.variant == "large"
    assert {profile.variant for profile in reloaded} == {"small", "large"}


def test_profile_store_discovers_models_beside_portable_executable(tmp_path) -> None:
    models = tmp_path / "models" / "muscriptor"
    _write_model(models / "small", "small")
    _write_model(models / "large", "large")
    store = ModelProfileStore(tmp_path / "UserData" / "model-profiles.json")

    discovered = store.discover_local_models([models])

    assert {profile.variant for profile in discovered} == {"small", "large"}
    assert {profile.profile_name for profile in discovered} == {
        "MuScriptor Small",
        "MuScriptor Large",
    }
    assert all(profile.default_backend == "Auto" for profile in discovered)
    assert all(profile.dtype == "float32" for profile in discovered)


def test_discovery_migrates_legacy_cpu_only_labels(tmp_path) -> None:
    models = tmp_path / "models" / "muscriptor"
    model_path = _write_model(models / "small", "small")
    store = ModelProfileStore(tmp_path / "UserData" / "model-profiles.json")
    legacy = store.register(
        profile_name="MuScriptor Small (CPU)",
        model_path=model_path,
        expected_variant="small",
        dtype="float32",
        default_backend="CPU",
    )

    discovered = store.discover_local_models([models])

    assert len(discovered) == 1
    assert discovered[0].id == legacy.id
    assert discovered[0].profile_name == "MuScriptor Small"
    assert discovered[0].default_backend == "Auto"
    assert store.list()[0].default_backend == "Auto"
