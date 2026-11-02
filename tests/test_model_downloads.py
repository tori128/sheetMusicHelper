import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from earcopy_service import model_downloads
from earcopy_service.api import create_app
from earcopy_service.model_profiles import ModelProfileStore
from tests.test_model_profiles import _write_model


@pytest.fixture
def distribution(tmp_path, monkeypatch):
    manifest = {"repository": "tori128/sheetMusicHelper", "releaseTag": "v0.1.6", "archiveRoot": "fixture", "models": []}
    contents = {}
    originals = {}
    release_assets = {}
    for variant in ("medium", "small", "large"):
        path = _write_model(tmp_path / "original" / variant, variant)
        originals[variant] = path.read_bytes()
        config = path.with_name("config.json").read_bytes()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as package:
            prefix = f"fixture/models/muscriptor/{variant}/"
            package.writestr(prefix + "config.json", config)
            package.writestr(prefix + "model.safetensors", originals[variant])
        archive = buffer.getvalue()
        volumes = []
        if variant == "large":
            boundary = len(archive) // 2
            volumes.append((f"{variant}.z01", b"PK\x07\x08" + archive[:boundary]))
            archive = archive[boundary:]
        volumes.append((f"{variant}.exe", b"MZ-fixture" + archive + b"EAC_ZIP_SFX_0001" + struct.pack("<q", len(archive))))
        model = {
            "variant": variant, "weightSizeBytes": len(originals[variant]),
            "weightSha256": hashlib.sha256(originals[variant]).hexdigest(),
            "configSizeBytes": len(config), "configSha256": hashlib.sha256(config).hexdigest(),
            "assets": [],
        }
        for name, payload in volumes:
            contents[name] = payload
            model["assets"].append(name)
            release_assets[name] = {"name": name, "size": len(payload), "state": "uploaded", "digest": "sha256:" + hashlib.sha256(payload).hexdigest()}
        manifest["models"].append(model)
    monkeypatch.setattr(model_downloads, "CATALOG", manifest)
    monkeypatch.setattr(model_downloads, "_release_assets", lambda _: release_assets)
    return contents, originals


@pytest.mark.parametrize("variant", ["medium", "small", "large"])
def test_download_installs_and_registers_each_variant_without_executing_packages(tmp_path, distribution, variant):
    contents, originals = distribution
    requests = []

    def respond(request):
        requests.append(request.url)
        return httpx.Response(200, content=contents[request.url.path.rsplit("/", 1)[-1]])

    root = tmp_path / "portable" / "models" / "muscriptor"
    store = ModelProfileStore(tmp_path / "portable" / "UserData" / "model-profiles.json")
    with httpx.Client(transport=httpx.MockTransport(respond)) as api:
        progress = []
        profile = model_downloads.download_muscriptor_model(variant, root, store, client=api, progress_callback=progress.append)
        repeated = model_downloads.download_muscriptor_model(variant, root, store, client=api)
    assert repeated.id == profile.id
    assert len(requests) == (2 if variant == "large" else 1)
    assert profile.variant == variant and profile.default_backend == "Auto"
    assert Path(profile.model_path).read_bytes() == originals[variant]
    assert store.list() == [profile]
    assert list(root.iterdir()) == [root / variant]
    received = [event for event in progress if event.phase == "downloading"]
    assert received[0].completed_bytes == 0
    assert received[-1].completed_bytes == received[-1].total_bytes == sum(len(contents[path.path.rsplit("/", 1)[-1]]) for path in requests)
    assert all(left.completed_bytes <= right.completed_bytes for left, right in zip(received, received[1:]))
    extracted = [event for event in progress if event.phase == "extracting"]
    assert extracted[-1].completed_bytes == extracted[-1].total_bytes
    assert progress[-1].phase == "registering"
    assert any(event.phase == "assembling" for event in progress) == (variant == "large")


def test_corrupted_download_preserves_existing_models_and_can_be_retried(tmp_path, distribution):
    contents, originals = distribution
    root = tmp_path / "models"
    existing_path = _write_model(root / "small", "small")
    store = ModelProfileStore(tmp_path / "UserData" / "model-profiles.json")
    existing = store.register("Small", existing_path, "small", "float32", "CPU")
    valid = contents["medium.exe"]
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" + valid[1:]))) as api:
        with pytest.raises(ValueError, match="SHA-256"):
            model_downloads.download_muscriptor_model("medium", root, store, client=api)
    assert not (root / "medium" / "model.safetensors").exists()
    assert store.list() == [existing]
    assert existing_path.read_bytes() == originals["small"]
    assert sorted(path.name for path in root.iterdir()) == ["small"]
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=valid))) as api:
        installed = model_downloads.download_muscriptor_model("medium", root, store, client=api)
    assert [item.variant for item in store.list()] == ["medium", "small"]
    assert installed.variant == "medium"


def test_download_failure_cleans_temporary_files_and_preserves_custom_model(tmp_path, distribution):
    root = tmp_path / "models"
    store = ModelProfileStore(tmp_path / "profiles.json")
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(503))) as api:
        with pytest.raises(RuntimeError, match="ネットワーク接続"):
            model_downloads.download_muscriptor_model("medium", root, store, client=api)
    assert list(root.iterdir()) == []
    target = root / "medium"
    target.mkdir()
    custom = target / "model.safetensors"
    custom.write_bytes(b"user model")
    with pytest.raises(ValueError, match="異なるモデル"):
        model_downloads.download_muscriptor_model("medium", root, store)
    assert custom.read_bytes() == b"user model"


def test_download_requires_disk_space_before_network_access(tmp_path, distribution, monkeypatch):
    from collections import namedtuple

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(model_downloads.shutil, "disk_usage", lambda _: usage(1, 1, 0))
    with pytest.raises(OSError, match="空き容量"):
        model_downloads.download_muscriptor_model("medium", tmp_path / "models", ModelProfileStore(tmp_path / "profiles.json"))


def test_download_api_uses_medium_by_default_and_requires_terms_and_session(tmp_path, monkeypatch):
    store = ModelProfileStore(tmp_path / "UserData" / "profiles.json")
    profile = store.register("Medium", _write_model(tmp_path / "source", "medium"), "medium", "float16", "Auto")
    root = tmp_path / "portable" / "models" / "muscriptor"
    monkeypatch.setenv("EARCOPY_MODELS_DIRS", str(root))
    calls = []

    def download(variant, destination, profiles, *, progress_callback):
        calls.append((variant, destination, profiles))
        return profile

    monkeypatch.setattr("earcopy_service.api.download_muscriptor_model", download)
    monkeypatch.setattr("earcopy_service.api.model_download_options", lambda profiles: [{"variant": "medium", "installed": True}])
    api = TestClient(create_app(session_token="secret", model_store=store))
    headers = {"Authorization": "Bearer secret"}
    assert api.get("/api/v1/models/download-options").status_code == 401
    assert api.post("/api/v1/models/download", json={"termsAccepted": True}).status_code == 401
    for body in ({}, {"termsAccepted": False}, {"variant": "unknown", "termsAccepted": True}):
        assert api.post("/api/v1/models/download", headers=headers, json=body).status_code == 422
    response = api.post("/api/v1/models/download", headers=headers, json={"termsAccepted": True})
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert response.status_code == 200 and events[-1]["result"]["id"] == str(profile.id)
    assert calls == [("medium", root, store)]
    options = api.get("/api/v1/models/download-options", headers=headers).json()
    assert options[0]["variant"] == "medium" and options[0]["installed"]


@pytest.mark.parametrize("draft,tag", [(True, "v0.1.7"), (False, "different")])
def test_release_metadata_must_match_a_published_release(draft, tag):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"draft": draft, "tag_name": tag, "assets": []}))) as api:
        with pytest.raises(ValueError, match="配布情報"):
            model_downloads._release_assets(api)


def test_release_metadata_uses_only_the_expected_repository_and_tag():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"draft": False, "tag_name": model_downloads.CATALOG["releaseTag"], "assets": [{"name": "model.exe", "size": 25, "state": "uploaded", "digest": "sha256:" + "a" * 64}]})
    with httpx.Client(transport=httpx.MockTransport(respond)) as api:
        assets = model_downloads._release_assets(api)
    assert requests[0].url.host == "api.github.com"
    assert requests[0].url.path == f"/repos/{model_downloads.CATALOG['repository']}/releases/tags/{model_downloads.CATALOG['releaseTag']}"
    resolved = model_downloads._resolve_assets({"assets": ["model.exe"]}, assets)
    assert resolved["assets"] == [{"name": "model.exe", "sizeBytes": 25, "sha256": "a" * 64}]


@pytest.mark.parametrize("updates", [{"digest": None}, {"digest": "sha256:invalid"}, {"size": 2 * 1024**3}, {"size": True}, {"state": "starter"}])
def test_unverifiable_release_assets_are_rejected(updates):
    asset = {"name": "model.exe", "size": 25, "state": "uploaded", "digest": "sha256:" + "a" * 64, **updates}
    with pytest.raises(ValueError, match="検証情報"):
        model_downloads._resolve_assets({"assets": ["model.exe"]}, {"model.exe": asset})


def test_download_options_report_missing_release_as_a_retryable_error():
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(404))) as api:
        with pytest.raises(RuntimeError, match="公開状態"):
            model_downloads.model_download_options([], client=api)


def test_download_options_resolve_sizes_and_installed_variants(tmp_path, distribution):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(500))) as api:
        options = model_downloads.model_download_options([], client=api)
    assert [item["variant"] for item in options] == ["medium", "small", "large"]
    assert all(item["downloadSizeBytes"] > 0 and item["requiredSpaceBytes"] > item["downloadSizeBytes"] for item in options)
