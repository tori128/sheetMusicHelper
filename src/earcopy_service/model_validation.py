from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ModelVariant = Literal["small", "medium", "large"]

_VARIANT_CONFIGS: dict[ModelVariant, tuple[int, int]] = {
    "small": (768, 14),
    "medium": (1024, 24),
    "large": (1536, 48),
}
_MAX_HEADER_BYTES = 100 * 1024 * 1024


class ModelValidationResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    file_name: str = Field(alias="fileName")
    sha256: str
    size_bytes: int = Field(alias="sizeBytes")
    estimated_memory_bytes: int = Field(alias="estimatedMemoryBytes")
    valid_container: bool = Field(alias="validContainer")
    loadable: bool
    tensor_count: int = Field(alias="tensorCount")
    dtypes: list[str]
    variant: ModelVariant | None
    config_path: str | None = Field(alias="configPath")
    errors: list[str]
    warnings: list[str]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_safetensors_header(path: Path) -> tuple[dict, list[str]]:
    errors: list[str] = []
    file_size = path.stat().st_size
    with path.open("rb") as model_file:
        header_size_bytes = model_file.read(8)
        if len(header_size_bytes) != 8:
            return {}, ["safetensorsヘッダー長を読み取れません"]
        header_size = int.from_bytes(header_size_bytes, "little")
        if not 2 <= header_size <= min(_MAX_HEADER_BYTES, file_size - 8):
            return {}, ["safetensorsヘッダー長が不正です"]
        raw_header = model_file.read(header_size)
    try:
        header = json.loads(raw_header)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}, ["safetensorsヘッダーが有効なUTF-8 JSONではありません"]
    if not isinstance(header, dict):
        return {}, ["safetensorsヘッダーのルートがオブジェクトではありません"]

    payload_size = file_size - 8 - header_size
    occupied_ranges: list[tuple[int, int]] = []
    for name, descriptor in header.items():
        if name == "__metadata__":
            continue
        if not isinstance(descriptor, dict):
            errors.append(f"テンソル{name}の記述が不正です")
            continue
        offsets = descriptor.get("data_offsets")
        shape = descriptor.get("shape")
        dtype = descriptor.get("dtype")
        if (
            not isinstance(offsets, list)
            or len(offsets) != 2
            or not all(isinstance(value, int) for value in offsets)
            or not isinstance(shape, list)
            or not isinstance(dtype, str)
        ):
            errors.append(f"テンソル{name}の属性が不足しています")
            continue
        start, end = offsets
        if not 0 <= start <= end <= payload_size:
            errors.append(f"テンソル{name}のデータ範囲がファイル外です")
            continue
        occupied_ranges.append((start, end))

    sorted_ranges = sorted(occupied_ranges)
    for previous, current in zip(sorted_ranges, sorted_ranges[1:], strict=False):
        if current[0] < previous[1]:
            errors.append("テンソルのデータ範囲が重複しています")
            break
    return header, errors


def _variant_from_config(config_path: Path) -> tuple[ModelVariant | None, list[str]]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, [f"config.jsonを読み取れません: {exc}"]
    try:
        signature = (int(config["dim"]), int(config["num_layers"]))
    except (KeyError, TypeError, ValueError):
        return None, ["config.jsonにdimまたはnum_layersがありません"]
    for variant, expected in _VARIANT_CONFIGS.items():
        if signature == expected:
            return variant, []
    return None, [f"未対応のモデル構成です: dim={signature[0]}, layers={signature[1]}"]


def validate_model_file(
    path: Path,
    expected_variant: ModelVariant | None = None,
) -> ModelValidationResult:
    path = path.resolve()
    if path.suffix.lower() != ".safetensors":
        raise ValueError("MuScriptorモデルは.safetensorsである必要があります")
    if not path.is_file():
        raise ValueError("モデルファイルが見つかりません")

    header, errors = _read_safetensors_header(path)
    tensor_descriptors = {
        name: descriptor
        for name, descriptor in header.items()
        if name != "__metadata__" and isinstance(descriptor, dict)
    }
    if not tensor_descriptors:
        errors.append("モデルにテンソルが含まれていません")
    dtypes = sorted(
        {
            str(descriptor["dtype"])
            for descriptor in tensor_descriptors.values()
            if "dtype" in descriptor
        }
    )
    config_path = path.with_name("config.json")
    warnings: list[str] = []
    variant: ModelVariant | None = None
    if config_path.is_file():
        variant, config_errors = _variant_from_config(config_path)
        errors.extend(config_errors)
    else:
        warnings.append(
            "config.jsonがありません。公式配布フォルダーのconfig.jsonをモデルと同じ場所へ配置してください"
        )

    if expected_variant is not None and variant is not None and expected_variant != variant:
        errors.append(
            f"指定variant={expected_variant}とconfig.jsonのvariant={variant}が一致しません"
        )
    if expected_variant is not None and variant is None:
        warnings.append(
            f"指定variant={expected_variant}はconfig.jsonがないため検証できません"
        )

    valid_container = bool(tensor_descriptors) and not any(
        "safetensors" in error or "テンソル" in error for error in errors
    )
    loadable = valid_container and variant is not None and not errors
    return ModelValidationResult(
        fileName=path.name,
        sha256=_sha256(path),
        sizeBytes=path.stat().st_size,
        estimatedMemoryBytes=int(path.stat().st_size * 2.5),
        validContainer=valid_container,
        loadable=loadable,
        tensorCount=len(tensor_descriptors),
        dtypes=dtypes,
        variant=variant,
        configPath=str(config_path) if config_path.is_file() else None,
        errors=errors,
        warnings=warnings,
    )
