import json
import re
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def test_public_release_documents_are_present_and_cross_linked() -> None:
    required = [
        REPOSITORY_ROOT / "LICENSE",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md",
        REPOSITORY_ROOT / "docs" / "README.md",
        REPOSITORY_ROOT / "docs" / "SPECIFICATION.md",
        REPOSITORY_ROOT / "docs" / "DEVELOPMENT.md",
        REPOSITORY_ROOT / "docs" / "DISTRIBUTION.md",
    ]
    assert all(path.is_file() and path.stat().st_size > 0 for path in required)

    readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
    for relative_path in (
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "docs/README.md",
        "docs/SPECIFICATION.md",
        "docs/DEVELOPMENT.md",
    ):
        assert relative_path in readme

    for obsolete in (
        REPOSITORY_ROOT / "docs" / "HANDOFF.md",
        REPOSITORY_ROOT / "docs" / "implementation-audit.md",
        REPOSITORY_ROOT / "docs" / "DEPENDENCIES.md",
    ):
        assert not obsolete.exists()


def test_local_markdown_links_resolve() -> None:
    documents = [
        REPOSITORY_ROOT / "README.md",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md",
        *sorted((REPOSITORY_ROOT / "docs").glob("*.md")),
    ]
    for document in documents:
        content = document.read_text(encoding="utf-8")
        for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
            if target.startswith(("http://", "https://", "#")):
                continue
            path = target.split("#", 1)[0]
            assert (document.parent / path).resolve().exists(), (
                f"{document.relative_to(REPOSITORY_ROOT)}: {target}"
            )


def test_notices_identify_bundled_assets_and_redistribution_constraints() -> None:
    notices = (REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md").read_text(
        encoding="utf-8"
    )
    for required_text in (
        "CC BY-NC 4.0",
        "719e5abb8ed920305dad546ac3cd6fb0b1e9c3092d14ce21827bfc0423af3070",
        "629a4901184bf1d3a75b0b13904f35974785aa042cad3c010fd576248cdce3f0",
        "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
        "GNU GPL version 3",
        "Complete Corresponding Source",
        "Apache License 2.0",
        "torch | 2.2.2+cu121",
    ):
        assert required_text in notices

    compact_notices = (
        REPOSITORY_ROOT
        / "app"
        / "resources"
        / "licenses"
        / "THIRD_PARTY_NOTICES.txt"
    ).read_text(encoding="utf-8")
    assert "SpessaSynth Core and SpessaSynth Lib: Apache License 2.0" in (
        compact_notices
    )
    assert "SCNet Large bundled weight" in compact_notices
    assert "HT-Demucs" not in compact_notices
    assert "SpessaSynth Core and SpessaSynth Lib: MIT License" not in (
        compact_notices
    )


def test_portable_build_includes_release_documents() -> None:
    package = json.loads(
        (REPOSITORY_ROOT / "app" / "package.json").read_text(encoding="utf-8")
    )
    resources = {
        entry["to"]: entry["from"]
        for entry in package["build"]["extraResources"]
    }
    assert resources["licenses/EarCopy_Assist_LICENSE.txt"] == "../LICENSE"
    assert resources["licenses/THIRD_PARTY_NOTICES.md"] == (
        "../THIRD_PARTY_NOTICES.md"
    )
    assert resources["licenses/DISTRIBUTION.md"] == "../docs/DISTRIBUTION.md"
    assert resources["models/scnet"] == "../models/scnet"

    specification = (
        REPOSITORY_ROOT / "app" / "packaging" / "earcopy_service.spec"
    ).read_text(encoding="utf-8")
    for distribution in ("muscriptor", "torch", "soxr"):
        assert f'"{distribution}"' in specification
    assert '"demucs"' not in specification
    assert "collect_distribution_licenses" in specification


def test_model_weights_are_excluded_from_git_candidates() -> None:
    gitignore = (REPOSITORY_ROOT / ".gitignore").read_text(encoding="utf-8")
    for pattern in (
        "models/",
        "*.safetensors",
        "*.ckpt",
        "*.pt",
        "*.pth",
        "*.onnx",
        "*.th",
        "*.gguf",
    ):
        assert pattern in gitignore
