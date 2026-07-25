from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from .model_validation import ModelVariant, validate_model_file

InferenceBackend = Literal["Auto", "CPU", "CUDA"]


class ModelProfile(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    id: UUID = Field(default_factory=uuid4)
    profile_name: str = Field(min_length=1, max_length=120, alias="profileName")
    model_path: str = Field(alias="modelPath")
    file_name: str = Field(alias="fileName")
    sha256: str
    variant: ModelVariant
    dtype: Literal["float32", "float16"]
    default_backend: InferenceBackend = Field(alias="defaultBackend")


class ModelProfileStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    def list(self) -> list[ModelProfile]:
        with self._lock:
            return self._load()

    def discover_local_models(self, directories: list[Path]) -> list[ModelProfile]:
        profiles = self.list()
        migrated_profiles = []
        migration_needed = False
        for profile in profiles:
            legacy_name = f"MuScriptor {profile.variant.title()} (CPU)"
            if (
                profile.profile_name == legacy_name
                and profile.default_backend == "CPU"
                and profile.dtype == "float32"
            ):
                profile = profile.model_copy(
                    update={
                        "profile_name": legacy_name.removesuffix(" (CPU)"),
                        "default_backend": "Auto",
                    }
                )
                migration_needed = True
            migrated_profiles.append(profile)
        profiles = migrated_profiles
        if migration_needed:
            with self._lock:
                self._save(profiles)

        known_paths = {Path(item.model_path).resolve() for item in profiles}
        for directory in directories:
            if not directory.is_dir():
                continue
            for variant in ("small", "medium", "large"):
                model_path = directory / variant / "model.safetensors"
                if not model_path.is_file() or model_path.resolve() in known_paths:
                    continue
                try:
                    profile = self.register(
                        profile_name=f"MuScriptor {variant.title()}",
                        model_path=model_path,
                        expected_variant=variant,
                        dtype="float32",
                        default_backend="Auto",
                    )
                except ValueError:
                    continue
                profiles = [
                    item for item in profiles if item.sha256 != profile.sha256
                ]
                profiles.append(profile)
                known_paths.add(model_path.resolve())
        return profiles

    def register(
        self,
        profile_name: str,
        model_path: Path,
        expected_variant: ModelVariant | None,
        dtype: Literal["float32", "float16"],
        default_backend: InferenceBackend,
    ) -> ModelProfile:
        validation = validate_model_file(model_path, expected_variant)
        if not validation.loadable or validation.variant is None:
            details = "; ".join(validation.errors + validation.warnings)
            raise ValueError(f"MuScriptorモデルを登録できません: {details}")
        if default_backend == "CPU" and dtype != "float32":
            raise ValueError("CPUバックエンドのdtypeはfloat32である必要があります")

        profile = ModelProfile(
            profileName=profile_name,
            modelPath=str(model_path.resolve()),
            fileName=model_path.name,
            sha256=validation.sha256,
            variant=validation.variant,
            dtype=dtype,
            defaultBackend=default_backend,
        )
        with self._lock:
            profiles = self._load()
            profiles = [item for item in profiles if item.sha256 != profile.sha256]
            profiles.append(profile)
            self._save(profiles)
        return profile

    def _load(self) -> list[ModelProfile]:
        if not self._path.exists():
            return []
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
            if payload.get("formatVersion") != 1:
                raise ValueError("モデルプロファイル形式のversionが未対応です")
            return [
                ModelProfile.model_validate(item)
                for item in payload.get("profiles", [])
            ]
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"モデルプロファイルを読み取れません: {exc}") from exc

    def _save(self, profiles: list[ModelProfile]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "formatVersion": 1,
            "profiles": [
                profile.model_dump(by_alias=True, mode="json")
                for profile in profiles
            ],
        }
        with NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            dir=self._path.parent,
            prefix=f".{self._path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            json.dump(payload, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary_path = Path(temporary.name)
        temporary_path.replace(self._path)


def configured_model_directories() -> list[Path]:
    value = os.getenv("EARCOPY_MODELS_DIRS", "")
    return [Path(item) for item in value.split(os.pathsep) if item]
