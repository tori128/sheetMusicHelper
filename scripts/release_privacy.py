"""Inspect distribution contents and emit diagnostics without private values."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import marshal
import os
from pathlib import Path, PurePosixPath
import re
import struct
import tempfile
import types
from urllib.parse import unquote
import zipfile

MODEL_CATALOG_PATH = Path(__file__).parent.parent / "src/earcopy_service/model-downloads.json"

def runtime_metadata(entries):
    result = []
    for entry in entries:
        parts = PurePosixPath(str(entry[0]).replace("\\", "/")).parts
        own = any(part.startswith("earcopy_assist-") and part.endswith(".dist-info") for part in parts)
        if parts[-1] == "direct_url.json" or own and parts[-1] != "METADATA":
            continue
        result.append(entry)
    return result


WINDOWS_HOME = re.compile(rb"(?i)(?:[a-z]:|/[a-z])[\\/]+users[\\/]+([^\\/\r\n\x00\"<>`]{1,100})")
UNIX_HOME = re.compile(rb"/(?:Users|home)/([^/\r\n\x00\"<>`]{1,100})")
DEVELOPER_HOME = re.compile(rb"(?i)(?:[a-z]:[\\/]+(?:MyDevelop|Projects|Repos)[\\/]+|/[a-z]/MyDevelop/)")
KEYS = re.compile(rb"\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{25,}|hf_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{20,})\b")
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{40,}")
SID = re.compile(rb"\bS-1-5-21-(?:\d+-){2}\d+(?:-\d+)?\b")
VENDOR_ACCOUNTS = {b"runneradmin", b"runner~1", b"administrator", b"admini~1", b"public", b"public.", b"public ", b"runner"}


class Inspector:
    def __init__(self, *, workspace: Path | None = None):
        self.findings = set()
        self.counts = {"files": 0, "bytes": 0, "codeObjects": 0, "nestedFiles": 0}
        self.seen_code = set()
        self.workspace = []
        if workspace is not None:
            value = str(workspace.resolve()).replace("\\", "/").lower()
            self.workspace = [value.encode(), value.replace("/", "\\").encode()]
        self.credentials = [os.environ[name].encode() for name in ("GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN") if os.environ.get(name)]
        self.credentials += [value.decode().encode(encoding) for value in list(self.credentials) for encoding in ("utf-16-le", "utf-16-be")]

    def reject(self, category, name):
        self.findings.add((category, hashlib.sha256(name.encode("utf-8", errors="replace")).hexdigest()))

    @staticmethod
    def vendor(name):
        return (name.endswith("/EarCopyAssist.exe") or any(part in name for part in ("/_internal/", "/node_modules/", "/licenses/"))) and "earcopy_assist-" not in name

    def text(self, data, name, vendor=False):
        lower = data.lower()
        if b"%" in data and any(marker in lower for marker in (b"users", b"%75", b"%5c", b"%2f")):
            data = unquote(data.decode("utf-8", errors="replace")).encode()
            lower = data.lower()
        if any(value in lower for value in self.workspace):
            self.reject("build-workspace-path", name)
        if b"users" in lower:
            for match in WINDOWS_HOME.finditer(data):
                account = match[1].lower().strip().rstrip(b".")
                if not vendor or account not in VENDOR_ACCOUNTS:
                    self.reject("Windows-user-path", name)
        if not vendor and (b"home" in data or b"Users" in data) and UNIX_HOME.search(data):
            self.reject("user-home-path", name)
        if b"mydevelop" in lower or not vendor and any(marker in lower for marker in (b"projects", b"repos")):
            if DEVELOPER_HOME.search(data): self.reject("developer-path", name)
        if any(marker in data for marker in (b"ghp_", b"gho_", b"ghu_", b"ghs_", b"ghr_", b"github_pat_", b"hf_", b"sk-", b"AKIA", b"AIza", b"xox")) and KEYS.search(data):
            self.reject("credential-shaped-value", name)
        if b"PRIVATE KEY-----" in data and PRIVATE_KEY.search(data): self.reject("private-key", name)
        if b"S-1-5-21-" in data and SID.search(data): self.reject("Windows-account-SID", name)
        if any(value in data for value in self.credentials): self.reject("build-credential", name)

    def block(self, data, name, vendor=False):
        self.text(data, name, vendor)
        if b"\0" in data:
            self.text(data.replace(b"\0", b""), name, vendor)

    def filename(self, name):
        normalized = name.replace("\\", "/")
        parts = PurePosixPath(normalized).parts
        lowered = {part.lower() for part in parts}
        if normalized.startswith("/") or ".." in parts or re.match(r"^[A-Za-z]:", normalized): self.reject("absolute-or-parent-entry", name)
        if lowered & {"userdata", ".git", ".aws", ".ssh", ".codex", ".env", "id_rsa", "id_ed25519"}: self.reject("private-file", name)
        if any(part.lower().startswith(".env.") for part in parts) or Path(name).suffix.lower() in {".log", ".dmp", ".pfx", ".p12", ".ecaproj"}: self.reject("private-file", name)
        if parts and parts[-1].lower() == "direct_url.json": self.reject("installation-origin-metadata", name)
        if not normalized.endswith("/") and any(part.startswith("earcopy_assist-") and part.endswith(".dist-info") for part in parts) and parts[-1] != "METADATA": self.reject("installation-tracking-metadata", name)
        self.block(normalized.encode(), name)

    def code(self, code, name, vendor):
        if not isinstance(code, types.CodeType): return
        self.counts["codeObjects"] += 1
        filename = code.co_filename
        if filename.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", filename): self.reject("absolute-Python-filename", name)
        self.text(filename.encode("utf-8", errors="replace"), name, vendor)
        for value in code.co_consts:
            if isinstance(value, types.CodeType): self.code(value, name, vendor)
            elif isinstance(value, str): self.text(value.encode("utf-8", errors="replace"), name, vendor)
            elif isinstance(value, bytes): self.block(value, name, vendor)

    def python_executable(self, data, name):
        from PyInstaller.archive.readers import CArchiveReader
        digest = hashlib.sha256(data).hexdigest()
        if digest in self.seen_code: return
        self.seen_code.add(digest)
        with tempfile.TemporaryDirectory(prefix="eac-privacy-") as folder:
            path = Path(folder) / "backend.exe"
            path.write_bytes(data)
            archive = CArchiveReader(str(path))
            for module, entry in archive.toc.items():
                if entry[-1] == "z":
                    pyz = archive.open_embedded_archive(module)
                    for item in pyz.toc:
                        vendor = not (item == "earcopy_service" or item.startswith("earcopy_service."))
                        self.code(pyz.extract(item), name + "::" + item, vendor)
                elif entry[-1] in {"s", "m", "M"}:
                    self.code(marshal.loads(archive.extract(module)), name + "::" + module, not module.startswith("backend_entry"))

    def asar(self, data, name):
        _, header_size = struct.unpack("<II", data[:8])
        text_size = struct.unpack("<I", data[12:16])[0]
        header = json.loads(data[16:16 + text_size])
        start = 8 + header_size
        def visit(node, prefix):
            for basename, entry in node.get("files", {}).items():
                child = prefix + "/" + basename
                self.filename(child)
                if "files" in entry: visit(entry, child)
                elif "offset" in entry:
                    offset = start + int(entry["offset"])
                    end = offset + entry["size"]
                    if end > len(data): raise ValueError("Invalid ASAR bounds")
                    self.counts["nestedFiles"] += 1
                    self.block(data[offset:end], child, "/node_modules/" in child)
        visit(header, name)

    def stream(self, stream, name, size):
        self.filename(name)
        self.counts["files"] += 1
        collect = name.endswith(("/earcopy_service.exe", "/base_library.zip", "/app.asar"))
        chunks = bytearray() if collect else None
        previous = b""
        vendor = self.vendor(name) or name.endswith(("/earcopy_service.exe", "/app.asar"))
        total = 0
        while block := stream.read(1024 * 1024):
            total += len(block)
            self.counts["bytes"] += len(block)
            self.block(previous + block, name, vendor)
            previous = block[-2048:]
            if chunks is not None: chunks.extend(block)
        if total != size: raise ValueError("Incorrect file length")
        if name.endswith("/earcopy_service.exe"): self.python_executable(bytes(chunks), name)
        elif name.endswith("/base_library.zip"):
            with zipfile.ZipFile(io.BytesIO(chunks)) as archive:
                for entry in archive.infolist():
                    if entry.is_dir(): continue
                    self.counts["nestedFiles"] += 1
                    child = name + "::" + entry.filename
                    self.filename(child)
                    blob = archive.read(entry)
                    self.block(blob, child, True)
                    if entry.filename.endswith(".pyc"): self.code(marshal.loads(blob[16:]), child, True)
        elif name.endswith("/app.asar"): self.asar(bytes(chunks), name)

    def directory(self, root):
        for path in sorted(root.rglob("*")):
            if path.is_file():
                name = "/" + path.relative_to(root).as_posix()
                with path.open("rb") as stream: self.stream(stream, "distribution" + name, path.stat().st_size)

    def self_extractor(self, path):
        with path.open("rb") as stream:
            stream.seek(-24, 2)
            footer = stream.read(24)
            if footer[:16] != b"EAC_ZIP_SFX_0001": raise ValueError("Invalid self-extractor footer")
            payload = struct.unpack("<q", footer[16:])[0]
            stub_size = path.stat().st_size - 24 - payload
            if not 0 < stub_size < 1024 * 1024: raise ValueError("Invalid self-extractor bounds")
            stream.seek(0)
            self.block(stream.read(stub_size), "self-extractor-stub")

    def archive(self, path, kind, variant=None):
        with zipfile.ZipFile(path) as archive:
            expected = None
            if kind == "model":
                catalog = json.loads(MODEL_CATALOG_PATH.read_text(encoding="utf-8"))
                model = next(item for item in catalog["models"] if item["variant"] == variant)
                prefix = f"{catalog['archiveRoot']}/models/muscriptor/{variant}/"
                expected = {prefix + "config.json": (model["configSizeBytes"], model["configSha256"]), prefix + "model.safetensors": (model["weightSizeBytes"], model["weightSha256"])}
                files = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
                if len(files) != len(expected) or set(files) != set(expected): self.reject("model-package-content", path.name)
            self.block(archive.comment, "ZIP-comment")
            for entry in archive.infolist():
                self.filename(entry.filename)
                self.block(entry.extra + entry.comment, entry.filename)
                if entry.is_dir(): continue
                if expected is not None:
                    if entry.filename not in expected: continue
                    size, digest = expected[entry.filename]
                    with archive.open(entry) as stream: actual = hashlib.file_digest(stream, "sha256").hexdigest()
                    self.counts["files"] += 1
                    self.counts["bytes"] += entry.file_size
                    if entry.file_size != size or actual != digest: self.reject("model-package-checksum", entry.filename)
                else:
                    with archive.open(entry) as stream: self.stream(stream, entry.filename, entry.file_size)

    def report(self):
        return {"passed": not self.findings, "counts": self.counts, "findings": [{"category": category, "itemId": item} for category, item in sorted(self.findings)]}


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--directory", type=Path)
    source.add_argument("--zip", type=Path)
    parser.add_argument("--self-extractor", type=Path)
    parser.add_argument("--kind", choices=["windows", "model", "sources"], default="windows")
    parser.add_argument("--variant", choices=["small", "medium", "large"])
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if not (args.directory or args.zip or args.self_extractor): parser.error("An inspection source is required")
    inspector = Inspector(workspace=Path(os.environ["GITHUB_WORKSPACE"]) if os.environ.get("GITHUB_WORKSPACE") else None)
    try:
        if args.directory: inspector.directory(args.directory)
        elif args.zip: inspector.archive(args.zip, args.kind, args.variant)
        if args.self_extractor: inspector.self_extractor(args.self_extractor)
    except Exception as error:
        inspector.reject("inspection-error-" + type(error).__name__, "distribution")
    report = inspector.report()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Distribution privacy check: {'passed' if report['passed'] else 'failed'}; files={report['counts']['files']}; issues={len(report['findings'])}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
