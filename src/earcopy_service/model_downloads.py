from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import threading
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from .download_progress import ProgressCallback, report_progress
from .model_profiles import ModelProfile, ModelProfileStore
from .model_validation import ModelVariant

CATALOG = json.loads(
    Path(__file__).with_name("model-downloads.json").read_text(encoding="utf-8")
)
_DOWNLOAD_LOCK = threading.Lock()
_SFX_FOOTER_MAGIC = b"EAC_ZIP_SFX_0001"


def _release_assets(api: httpx.Client) -> dict[str, dict]:
    response = api.get(
        f"https://api.github.com/repos/{CATALOG['repository']}/releases/tags/{CATALOG['releaseTag']}",
        headers={"Accept": "application/vnd.github+json"},
    )
    response.raise_for_status()
    release = response.json()
    if release.get("draft") is not False or release.get("tag_name") != CATALOG["releaseTag"]:
        raise ValueError("モデルの配布情報がリリースと一致しません")
    assets = {}
    for asset in release.get("assets", []):
        name = asset.get("name")
        if not isinstance(name, str) or name in assets:
            raise ValueError("モデルの配布ファイル情報が不正です")
        assets[name] = asset
    return assets


def _resolve_assets(model: dict, assets: dict[str, dict]) -> dict:
    resolved = []
    for name in model["assets"]:
        asset = assets.get(name, {})
        size, digest = asset.get("size"), asset.get("digest")
        if (asset.get("state") != "uploaded" or type(size) is not int or not 0 < size < 2 * 1024**3
                or not isinstance(digest, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None):
            raise ValueError("モデルの配布ファイルが見つからないか、検証情報が不正です")
        resolved.append({"name": name, "sizeBytes": size, "sha256": digest[7:]})
    return {**model, "assets": resolved}


def model_download_options(profiles: list[ModelProfile], *, client: httpx.Client | None = None) -> list[dict]:
    owns_client = client is None
    api = client or httpx.Client(follow_redirects=True, timeout=httpx.Timeout(60, connect=30))
    try:
        assets = _release_assets(api)
        models = [_resolve_assets(model, assets) for model in CATALOG["models"]]
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("モデルの配布情報を取得できませんでした。接続とリリースの公開状態を確認してください") from exc
    finally:
        if owns_client: api.close()
    return [
        {
            "variant": model["variant"],
            "downloadSizeBytes": sum(asset["sizeBytes"] for asset in model["assets"]),
            "requiredSpaceBytes": _required_space(model),
            "installed": any(
                profile.variant == model["variant"]
                and Path(profile.model_path).is_file()
                and Path(profile.model_path).with_name("config.json").is_file()
                for profile in profiles
            ),
        }
        for model in models
    ]


def _required_space(model: dict) -> int:
    download_size = sum(asset["sizeBytes"] for asset in model["assets"])
    return (
        download_size * (2 if len(model["assets"]) > 1 else 1)
        + model["weightSizeBytes"]
        + model["configSizeBytes"]
    )


def _matches(path: Path, size: int, sha256: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == sha256


def _download_asset(api: httpx.Client, asset: dict, destination: Path, progress_callback: ProgressCallback | None, offset: int, total: int) -> None:
    url = (
        f"https://github.com/{CATALOG['repository']}/releases/download/"
        f"{CATALOG['releaseTag']}/{asset['name']}"
    )
    digest = hashlib.sha256()
    received = 0
    report_progress(progress_callback, "downloading", offset, total)
    with api.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
        response.raise_for_status()
        length = response.headers.get("Content-Length")
        if length is not None and int(length) != asset["sizeBytes"]:
            raise ValueError("モデル配布ファイルのサイズが一致しません")
        with destination.open("xb") as output:
            for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                received += len(chunk)
                if received > asset["sizeBytes"]:
                    raise ValueError("モデル配布ファイルの受信サイズが上限を超えました")
                output.write(chunk)
                digest.update(chunk)
                report_progress(progress_callback, "downloading", offset + received, total)
    report_progress(progress_callback, "verifying")
    if received != asset["sizeBytes"] or digest.hexdigest() != asset["sha256"]:
        raise ValueError("モデル配布ファイルのサイズまたはSHA-256が一致しません")


def _package_archive(paths: list[Path], temporary: Path, progress_callback: ProgressCallback | None) -> Path:
    final = paths[-1]
    with final.open("rb") as source:
        source.seek(-24, 2)
        footer = source.read(24)
    if footer[:16] != _SFX_FOOTER_MAGIC:
        raise ValueError("モデル配布ファイルのZIP情報が不正です")
    payload_size = struct.unpack("<q", footer[16:])[0]
    offset = final.stat().st_size - 24 - payload_size
    if payload_size <= 0 or offset < 0:
        raise ValueError("モデル配布ファイルのZIPサイズが不正です")
    if len(paths) == 1:
        return final

    # The existing self-extractor splits a single ZIP into consecutive byte ranges.
    archive = temporary / "model.zip"
    total = sum(path.stat().st_size for path in paths[:-1]) - 4 + payload_size
    report_progress(progress_callback, "assembling", 0, total)
    with archive.open("xb") as output:
        for index, path in enumerate(paths[:-1]):
            with path.open("rb") as source:
                if index == 0 and source.read(4) != b"PK\x07\x08":
                    raise ValueError("モデル配布ファイルの先頭ボリュームが不正です")
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(chunk)
                    report_progress(progress_callback, "assembling", output.tell(), total)
        with final.open("rb") as source:
            source.seek(offset)
            remaining = payload_size
            while remaining:
                chunk = source.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise ValueError("モデル配布ファイルのZIPデータが不足しています")
                output.write(chunk)
                remaining -= len(chunk)
                report_progress(progress_callback, "assembling", output.tell(), total)
    return archive


def _extract_model(archive: Path, model: dict, destination: Path, progress_callback: ProgressCallback | None) -> None:
    prefix = f"{CATALOG['archiveRoot']}/models/muscriptor/{model['variant']}/"
    expected = {
        "config.json": (model["configSizeBytes"], model["configSha256"]),
        "model.safetensors": (model["weightSizeBytes"], model["weightSha256"]),
    }
    extracted = 0
    total = model["configSizeBytes"] + model["weightSizeBytes"]
    report_progress(progress_callback, "extracting", 0, total)
    try:
        with zipfile.ZipFile(archive) as package:
            entries = [item for item in package.infolist() if not item.is_dir()]
            if sorted(item.filename for item in entries) != sorted(
                prefix + name for name in expected
            ):
                raise ValueError("モデル配布ファイルの内容が一致しません")
            for name, (size, sha256) in expected.items():
                entry = package.getinfo(prefix + name)
                if entry.file_size != size:
                    raise ValueError("展開後のモデルファイルのサイズが一致しません")
                path = destination / name
                digest = hashlib.sha256()
                received = 0
                with package.open(entry) as source, path.open("xb") as output:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        received += len(chunk)
                        if received > size:
                            raise ValueError("展開後のモデルファイルのサイズが上限を超えました")
                        output.write(chunk)
                        digest.update(chunk)
                        extracted += len(chunk)
                        report_progress(progress_callback, "extracting", extracted, total)
                if received != size or digest.hexdigest() != sha256:
                    raise ValueError("展開後のモデルファイルのSHA-256が一致しません")
    except zipfile.BadZipFile as exc:
        raise ValueError("モデル配布ファイルを展開できません") from exc


def download_muscriptor_model(
    variant: ModelVariant,
    model_root: Path,
    store: ModelProfileStore,
    *,
    client: httpx.Client | None = None,
    progress_callback: ProgressCallback | None = None,
) -> ModelProfile:
    model = next(item for item in CATALOG["models"] if item["variant"] == variant)
    report_progress(progress_callback, "preparing")
    with _DOWNLOAD_LOCK:
        report_progress(progress_callback, "verifying")
        model_root.mkdir(parents=True, exist_ok=True)
        target = model_root / variant
        weight = target / "model.safetensors"
        config = target / "config.json"
        complete = _matches(
            weight, model["weightSizeBytes"], model["weightSha256"]
        ) and _matches(
            config, model["configSizeBytes"], model["configSha256"]
        )
        if not complete:
            if weight.exists() or (
                config.exists()
                and not _matches(config, model["configSizeBytes"], model["configSha256"])
            ):
                raise ValueError(
                    "保存先に異なるモデルファイルがあります。登録済みのモデルを確認してください"
                )
            if shutil.disk_usage(model_root).free < model["weightSizeBytes"] + model["configSizeBytes"]:
                raise OSError("モデルの取得と展開に必要な空き容量が不足しています")
            owns_client = client is None
            api = client or httpx.Client(
                follow_redirects=True, timeout=httpx.Timeout(60, connect=30)
            )
            try:
                report_progress(progress_callback, "preparing")
                model = _resolve_assets(model, _release_assets(api))
                if shutil.disk_usage(model_root).free < _required_space(model):
                    raise OSError("モデルの取得と展開に必要な空き容量が不足しています")
                with TemporaryDirectory(
                    prefix=f".{variant}-download-", dir=model_root
                ) as directory:
                    temporary = Path(directory)
                    paths = []
                    downloaded = 0
                    total = sum(asset["sizeBytes"] for asset in model["assets"])
                    for asset in model["assets"]:
                        path = temporary / asset["name"]
                        _download_asset(api, asset, path, progress_callback, downloaded, total)
                        downloaded += asset["sizeBytes"]
                        paths.append(path)
                    extracted = temporary / "extracted"
                    extracted.mkdir()
                    _extract_model(_package_archive(paths, temporary, progress_callback), model, extracted, progress_callback)
                    target.mkdir(exist_ok=True)
                    (extracted / "config.json").replace(config)
                    (extracted / "model.safetensors").replace(weight)
            except httpx.HTTPError as exc:
                raise RuntimeError(
                    "モデルを取得できませんでした。ネットワーク接続を確認して再度取得してください"
                ) from exc
            finally:
                if owns_client:
                    api.close()
        report_progress(progress_callback, "registering")
        existing = next(
            (
                profile for profile in store.list()
                if Path(profile.model_path).resolve() == weight.resolve()
                and profile.sha256 == model["weightSha256"]
                and profile.variant == variant
            ),
            None,
        )
        if existing is not None:
            return existing
        return store.register(f"MuScriptor {variant.title()}", weight, variant, "float16", "Auto")
