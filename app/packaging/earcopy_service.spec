from pathlib import Path
import shutil
import sys
from importlib.metadata import PackageNotFoundError, distribution

from PyInstaller.utils.hooks import collect_all, collect_submodules


app_root = Path(SPECPATH).parent
repository_root = app_root.parent
muscriptor_datas, muscriptor_binaries, muscriptor_hidden = collect_all(
    "muscriptor"
)
ffmpeg_path = Path(shutil.which("ffmpeg") or "")
ffprobe_path = Path(shutil.which("ffprobe") or "")
if not ffmpeg_path.is_file() or not ffprobe_path.is_file():
    raise RuntimeError("配布ビルドにはffmpegとffprobeが必要です")
ffmpeg_root = ffmpeg_path.parent.parent
ffmpeg_license = ffmpeg_root / "LICENSE"
ffmpeg_readme = ffmpeg_root / "README.txt"
media_binaries = [
    (str(ffmpeg_path), "tools"),
    (str(ffprobe_path), "tools"),
]
media_datas = [
    (str(path), "licenses/ffmpeg")
    for path in (ffmpeg_license, ffmpeg_readme)
    if path.is_file()
]

runtime_distributions = [
    "annotated-doc",
    "annotated-types",
    "anyio",
    "audioread",
    "certifi",
    "cffi",
    "charset-normalizer",
    "click",
    "colorama",
    "decorator",
    "einops",
    "fastapi",
    "filelock",
    "fsspec",
    "h11",
    "hf-xet",
    "httpcore",
    "httptools",
    "httpx",
    "huggingface-hub",
    "idna",
    "Jinja2",
    "joblib",
    "lazy-loader",
    "librosa",
    "llvmlite",
    "markdown-it-py",
    "MarkupSafe",
    "mdurl",
    "mido",
    "mpmath",
    "msgpack",
    "muscriptor",
    "narwhals",
    "networkx",
    "numba",
    "numpy",
    "packaging",
    "platformdirs",
    "pooch",
    "pycparser",
    "pydantic",
    "pydantic-core",
    "Pygments",
    "python-dotenv",
    "python-multipart",
    "PyYAML",
    "requests",
    "rich",
    "safetensors",
    "scikit-learn",
    "scipy",
    "setuptools",
    "shellingham",
    "soundfile",
    "soxr",
    "starlette",
    "sympy",
    "threadpoolctl",
    "torch",
    "torchaudio",
    "tqdm",
    "typer",
    "typing-extensions",
    "typing-inspection",
    "urllib3",
    "uvicorn",
    "watchfiles",
    "websockets",
]


def collect_distribution_licenses(distribution_names):
    collected = []
    for requested_name in distribution_names:
        try:
            package = distribution(requested_name)
        except PackageNotFoundError as error:
            raise RuntimeError(
                f"Runtime license metadata is missing: {requested_name}"
            ) from error
        package_directory = (
            f"{package.metadata['Name'].replace('_', '-')}-{package.version}"
        )
        for entry in package.files or []:
            if not entry.name.upper().startswith(
                ("LICENSE", "LICENCE", "COPYING", "NOTICE")
            ):
                continue
            source = Path(package.locate_file(entry))
            if not source.is_file():
                continue
            relative_parent = Path(*entry.parts[1:]).parent
            destination = (
                Path("licenses")
                / "python"
                / package_directory
                / relative_parent
            )
            collected.append((str(source), str(destination)))
    return collected


python_license = Path(sys.base_prefix) / "LICENSE.txt"
if not python_license.is_file():
    raise RuntimeError("CPython license text is missing")
runtime_license_datas = collect_distribution_licenses(runtime_distributions)
runtime_license_datas.append(
    (str(python_license), "licenses/python/Python-3.11")
)

analysis = Analysis(
    [str(app_root / "packaging" / "backend_entry.py")],
    pathex=[str(repository_root / "src")],
    binaries=muscriptor_binaries + media_binaries,
    datas=(
        muscriptor_datas
        + media_datas
        + runtime_license_datas
    ),
    hiddenimports=(
        muscriptor_hidden
        + collect_submodules("muscriptor")
        + collect_submodules("earcopy_service")
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "__main__"],
    noarchive=False,
)
python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="earcopy_service",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
)

collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="earcopy_service",
)
