import hashlib
import io
import json
import marshal
from pathlib import Path
import struct
import sys
from urllib.parse import quote
import zipfile

import pytest
from PyInstaller.archive.writers import CArchiveWriter, ZlibArchiveWriter

from scripts import release_privacy
from scripts.release_privacy import Inspector, runtime_metadata


def private_home():
    return "/".join(["Q:", "Users", "Synthetic Account", "project"])


def inspect(data, name="distribution/info.json", vendor=False):
    inspector = Inspector()
    inspector.block(data, name, vendor)
    return inspector.report()


def test_distribution_metadata_contains_runtime_version_only():
    root = "earcopy_assist-0.1.7.dist-info/"
    entries = [(root + name, "source", "DATA") for name in ["METADATA", "direct_url.json", "RECORD", "INSTALLER", "WHEEL", "REQUESTED"]]
    entries += [("other.dist-info/METADATA", "source", "DATA"), ("other.dist-info/direct_url.json", "source", "DATA")]
    assert [entry[0] for entry in runtime_metadata(entries)] == [root + "METADATA", "other.dist-info/METADATA"]


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16-le", "utf-16-be"])
def test_private_user_paths_fail_without_exposing_the_value(encoding):
    report = inspect(private_home().encode(encoding))
    assert not report["passed"]
    assert "Synthetic" not in json.dumps(report)
    assert "Windows-user-path" in {finding["category"] for finding in report["findings"]}


def test_url_encoded_installation_path_is_detected():
    assert not inspect(quote(private_home(), safe="").encode())["passed"]


def test_vendor_runner_path_exception_applies_only_to_vendor_contents():
    value = "/".join(["C:", "Users", "runneradmin", "build"]).encode()
    assert inspect(value, vendor=True)["passed"]
    assert not inspect(value, vendor=False)["passed"]
    assert not inspect(private_home().encode(), vendor=True)["passed"]


def test_current_workspace_and_credentials_are_detected(monkeypatch, tmp_path):
    credential = "token" + "x" * 32
    monkeypatch.setenv("GH_TOKEN", credential)
    inspector = Inspector(workspace=tmp_path)
    inspector.block((str(tmp_path) + " " + credential).encode(), "distribution/metadata")
    report = inspector.report()
    assert {"build-workspace-path", "build-credential"} <= {item["category"] for item in report["findings"]}
    assert credential not in json.dumps(report)


@pytest.mark.parametrize("value", ["gh" + "p_" + "x" * 30, "h" + "f_" + "y" * 30, "-----BEGIN " + "PRIVATE KEY-----\n" + "A" * 60])
def test_credential_material_is_rejected_and_redacted(value):
    report = inspect(value.encode())
    assert not report["passed"]
    assert value not in json.dumps(report)


def test_private_files_and_origin_metadata_are_rejected(tmp_path):
    path = tmp_path / "fixture.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("application/UserData/preferences.json", "{}")
        archive.writestr("application/package.dist-info/direct_url.json", "{}")
    inspector = Inspector()
    inspector.archive(path, "windows")
    assert {item["category"] for item in inspector.report()["findings"]} == {"private-file", "installation-origin-metadata"}


def test_zip_metadata_directory_allows_only_runtime_version_file(tmp_path):
    path = tmp_path / "fixture.zip"
    root = "application/resources/backend/_internal/earcopy_assist-0.1.7.dist-info/"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(root, b"")
        archive.writestr(root + "METADATA", "Name: earcopy-assist\nVersion: 0.1.7\n")
    inspector = Inspector()
    inspector.archive(path, "windows")
    assert inspector.report()["passed"]
    with zipfile.ZipFile(path, "a") as archive:
        archive.writestr(root + "uv_build.json", "{}")
    inspector = Inspector()
    inspector.archive(path, "windows")
    assert {item["category"] for item in inspector.report()["findings"]} == {"installation-tracking-metadata"}


def test_nested_standard_library_bytecode_is_inspected(tmp_path):
    code = compile("value = 1", private_home() + "/module.py", "exec")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("module.pyc", bytes(16) + marshal.dumps(code))
    inspector = Inspector()
    inspector.stream(io.BytesIO(buffer.getvalue()), "application/resources/backend/_internal/base_library.zip", len(buffer.getvalue()))
    assert "absolute-Python-filename" in {item["category"] for item in inspector.report()["findings"]}


def test_embedded_python_archive_is_inspected_without_executing_code(tmp_path):
    module = "earcopy_service.fixture"
    pyz = tmp_path / "PYZ.pyz"
    code = compile("value=" + repr(private_home()) + "\nraise RuntimeError('execution is forbidden')", "fixture.py", "exec")
    ZlibArchiveWriter(str(pyz), [(module, "fixture.py", "PYMODULE")], {module: code})
    executable = tmp_path / "backend.pkg"
    CArchiveWriter(str(executable), [("PYZ.pyz", str(pyz), False, "z")], "python311.dll")
    data = executable.read_bytes()
    inspector = Inspector()
    inspector.stream(io.BytesIO(data), "application/resources/backend/earcopy_service.exe", len(data))
    assert not inspector.report()["passed"]
    assert inspector.counts["codeObjects"] > 0


def test_asar_contents_are_inspected():
    contents = private_home().encode()
    header = json.dumps({"files": {"private.js": {"size": len(contents), "offset": "0"}}}).encode()
    payload = struct.pack("<I", len(header)) + header
    payload += bytes((-len(payload)) % 4)
    header = struct.pack("<I", len(payload)) + payload
    data = struct.pack("<II", 4, len(header)) + header + contents
    inspector = Inspector()
    inspector.stream(io.BytesIO(data), "application/resources/app.asar", len(data))
    assert not inspector.report()["passed"]
    assert inspector.counts["nestedFiles"] == 1


def test_model_package_accepts_only_the_canonical_files(monkeypatch, tmp_path):
    weight, config = b"canonical weights", b'{}'
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"archiveRoot": "application", "models": [{"variant": "small", "weightSizeBytes": len(weight), "weightSha256": hashlib.sha256(weight).hexdigest(), "configSizeBytes": len(config), "configSha256": hashlib.sha256(config).hexdigest()}]}))
    monkeypatch.setattr(release_privacy, "MODEL_CATALOG_PATH", catalog)
    path = tmp_path / "model.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("application/models/muscriptor/small/model.safetensors", weight)
        archive.writestr("application/models/muscriptor/small/config.json", config)
    inspector = Inspector()
    inspector.archive(path, "model", "small")
    assert inspector.report()["passed"]
    with zipfile.ZipFile(path, "a") as archive:
        archive.writestr("application/private.txt", private_home())
    inspector = Inspector()
    inspector.archive(path, "model", "small")
    assert not inspector.report()["passed"]


def test_cli_failure_output_and_report_are_redacted(monkeypatch, capsys, tmp_path):
    folder = tmp_path / "distribution"
    folder.mkdir()
    (folder / "metadata.json").write_text(private_home())
    report = tmp_path / "result.json"
    monkeypatch.setattr(sys, "argv", ["release_privacy", "--directory", str(folder), "--report", str(report)])
    assert release_privacy.main() == 1
    assert not json.loads(report.read_text())["passed"]
    assert "Synthetic" not in report.read_text() + str(capsys.readouterr())
