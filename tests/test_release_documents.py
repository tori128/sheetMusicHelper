import json
import os
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PROHIBITED_JAPANESE_TERMS = (
    "寄せる",
    "整理する",
    "汚す",
    "固定する",
    "つながる経路",
    "契約",
    "壊す",
    "見失う",
    "小さく",
    "大きく",
)


def test_first_party_documents_and_ui_exclude_prohibited_japanese_terms() -> None:
    paths = [
        REPOSITORY_ROOT / "README.md",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md",
        *sorted((REPOSITORY_ROOT / "docs").rglob("*.md")),
        *sorted((REPOSITORY_ROOT / "app" / "src").rglob("*.ts")),
        *sorted((REPOSITORY_ROOT / "app" / "src").rglob("*.tsx")),
        *sorted((REPOSITORY_ROOT / "src" / "earcopy_service").rglob("*.py")),
    ]
    for path in paths:
        if "_vendor" in path.parts:
            continue
        content = path.read_text(encoding="utf-8")
        for term in PROHIBITED_JAPANESE_TERMS:
            assert term not in content, (path.relative_to(REPOSITORY_ROOT), term)


def test_public_release_documents_are_present_and_cross_linked() -> None:
    required = [
        REPOSITORY_ROOT / "LICENSE",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.en.md",
        REPOSITORY_ROOT / "README.en.md",
        REPOSITORY_ROOT / "docs" / "USER_GUIDE.md",
        REPOSITORY_ROOT / "docs" / "USER_GUIDE.en.md",
        REPOSITORY_ROOT / "docs" / "TRANSCRIPTION_METHOD_BENCHMARK.md",
        REPOSITORY_ROOT / "docs" / "TRANSCRIPTION_METHOD_BENCHMARK.en.md",
        REPOSITORY_ROOT / "docs" / "developer" / "DEVELOPMENT.md",
        REPOSITORY_ROOT / "docs" / "developer" / "DEVELOPMENT.en.md",
        REPOSITORY_ROOT / "docs" / "developer" / "DISTRIBUTION.md",
        REPOSITORY_ROOT / "docs" / "developer" / "DISTRIBUTION.en.md",
        REPOSITORY_ROOT
        / "docs"
        / "developer"
        / "TEMPO_DOWNBEAT_EVALUATION.md",
        REPOSITORY_ROOT
        / "docs"
        / "developer"
        / "TEMPO_DOWNBEAT_EVALUATION.en.md",
    ]
    assert all(path.is_file() and path.stat().st_size > 0 for path in required)

    readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
    for relative_path in (
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "README.en.md",
        "docs/USER_GUIDE.md",
        "docs/USER_GUIDE.en.md",
        "docs/TRANSCRIPTION_METHOD_BENCHMARK.en.md",
        "docs/developer/DEVELOPMENT.md",
        "docs/developer/DEVELOPMENT.en.md",
        "docs/developer/DISTRIBUTION.md",
        "docs/developer/DISTRIBUTION.en.md",
        "docs/developer/TEMPO_DOWNBEAT_EVALUATION.md",
        "docs/developer/TEMPO_DOWNBEAT_EVALUATION.en.md",
    ):
        assert relative_path in readme

    for obsolete in (
        REPOSITORY_ROOT / "docs" / "HANDOFF.md",
        REPOSITORY_ROOT / "docs" / "implementation-audit.md",
        REPOSITORY_ROOT / "docs" / "DEPENDENCIES.md",
        REPOSITORY_ROOT / "docs" / "README.md",
        REPOSITORY_ROOT / "docs" / "SPECIFICATION.md",
    ):
        assert not obsolete.exists()


def test_stem_model_download_requires_acknowledgement_and_verifies_weight() -> None:
    service = (
        REPOSITORY_ROOT / "src/earcopy_service/stem_separation.py"
    ).read_text(encoding="utf-8")
    api = (REPOSITORY_ROOT / "src/earcopy_service/api.py").read_text(
        encoding="utf-8"
    )
    renderer_api = (REPOSITORY_ROOT / "app/src/api.ts").read_text(
        encoding="utf-8"
    )
    dialog = (
        REPOSITORY_ROOT / "app/src/components/StemModelDownloadDialog.tsx"
    ).read_text(encoding="utf-8")

    for value in (
        "ad54168acf271482ad51702953e162a385b8fdcb",
        "699_412_152",
        "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
        'license_status="Unknown"',
        'temporary_path = model_path.with_name(f"{model_path.name}.download")',
        "os.fsync",
        "temporary_path.replace(model_path)",
    ):
        assert value in service

    assert "license_status_acknowledged: Literal[True]" in api
    assert 'alias="licenseStatusAcknowledged"' in api
    assert '"/api/v1/stem-separation/model/download"' in renderer_api
    assert "ライセンスがUnknown" in dialog
    assert "disabled={!acknowledged || downloading}" in dialog


def test_local_markdown_links_resolve() -> None:
    documents = [
        REPOSITORY_ROOT / "README.md",
        REPOSITORY_ROOT / "README.en.md",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md",
        REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.en.md",
        *sorted((REPOSITORY_ROOT / "docs").rglob("*.md")),
    ]
    for document in documents:
        content = document.read_text(encoding="utf-8")
        assert "](assets\\" not in content, document.relative_to(
            REPOSITORY_ROOT
        )
        for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
            if target.startswith(("http://", "https://", "#")):
                continue
            path = target.split("#", 1)[0]
            assert (document.parent / path).resolve().exists(), (
                f"{document.relative_to(REPOSITORY_ROOT)}: {target}"
            )


def test_public_language_pairs_preserve_shared_facts() -> None:
    pairs = (
        ("README.md", "README.en.md"),
        ("docs/USER_GUIDE.md", "docs/USER_GUIDE.en.md"),
        (
            "docs/TRANSCRIPTION_METHOD_BENCHMARK.md",
            "docs/TRANSCRIPTION_METHOD_BENCHMARK.en.md",
        ),
        (
            "docs/developer/DEVELOPMENT.md",
            "docs/developer/DEVELOPMENT.en.md",
        ),
        (
            "docs/developer/DISTRIBUTION.md",
            "docs/developer/DISTRIBUTION.en.md",
        ),
        (
            "docs/developer/TEMPO_DOWNBEAT_EVALUATION.md",
            "docs/developer/TEMPO_DOWNBEAT_EVALUATION.en.md",
        ),
        ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.en.md"),
    )

    def external_urls(document: str) -> set[str]:
        return set(re.findall(r"https?://[^)>\s]+", document))

    def checksums(document: str) -> set[str]:
        return set(re.findall(r"\b[0-9a-f]{32}(?:[0-9a-f]{32})?\b", document))

    for japanese_path, english_path in pairs:
        japanese = (REPOSITORY_ROOT / japanese_path).read_text(encoding="utf-8")
        english = (REPOSITORY_ROOT / english_path).read_text(encoding="utf-8")
        japanese_heading_levels = re.findall(r"^(#+) ", japanese, re.MULTILINE)
        english_heading_levels = re.findall(r"^(#+) ", english, re.MULTILINE)
        assert japanese_heading_levels == english_heading_levels, (
            japanese_path,
            english_path,
        )
        assert external_urls(japanese) == external_urls(english), (
            japanese_path,
            english_path,
        )
        assert checksums(japanese) == checksums(english), (
            japanese_path,
            english_path,
        )

    synchronized_facts = {
        ("docs/USER_GUIDE.md", "docs/USER_GUIDE.en.md"): (
            "EarCopyAssist.exe",
            "UserData",
        ),
        (
            "docs/TRANSCRIPTION_METHOD_BENCHMARK.md",
            "docs/TRANSCRIPTION_METHOD_BENCHMARK.en.md",
        ): (
            "0.3954",
            "0.5253",
            "0.5016",
            "0.5167",
            "0.2507",
            "0.3759",
            "0.3533",
            "0.3646",
            "0.5411",
            "0.4653",
            "311096dc2bde7d61c97e930edbfc7f78",
        ),
        (
            "docs/developer/TEMPO_DOWNBEAT_EVALUATION.md",
            "docs/developer/TEMPO_DOWNBEAT_EVALUATION.en.md",
        ): (
            "0.7200",
            "0.3517%",
            "0.7651",
            "0.2665",
            "a61439e86c13037011fde8e0f0743ec55c50bce3",
            "890407d158078527ab396b49fea3c8a83e5734ee",
        ),
    }
    for paths, facts in synchronized_facts.items():
        documents = [
            (REPOSITORY_ROOT / path).read_text(encoding="utf-8")
            for path in paths
        ]
        for fact in facts:
            assert all(fact in document for document in documents), (paths, fact)


def test_public_benchmark_uses_the_four_published_conditions() -> None:
    result = json.loads(
        (
            REPOSITORY_ROOT
            / "docs/benchmarks/data/babyslakh-medium-fp16.json"
        ).read_text(encoding="utf-8")
    )
    assert tuple(result["aggregate"]) == (
        "direct",
        "separatedRouted",
        "separatedRoutedGuidedNoNoteFilter",
        "separatedRoutedGuided",
    )
    separated = result["configuration"]["sourceSeparation"]
    assert separated["drumComponentMixing"] == {
        "drumOnsetGuide": True,
        "inputs": ["bass", "piano", "guitar", "vocals", "other"],
        "timingGuideGains": {
            "bass": 0.2,
            "piano": 0.2,
            "guitar": 0.2,
            "vocals": 0.2,
            "other": 0.2,
        },
        "bassTimingGuideHighpassHz": 350.0,
        "discardDrumEvents": True,
        "timingGuideNoteFilter": True,
    }
    expected_f1 = (0.3954, 0.5253, 0.5016, 0.5167)
    measured_f1 = tuple(
        condition["score50Ms"]["microF1"]
        for condition in result["aggregate"].values()
    )
    assert measured_f1 == expected_f1
    expected_timing_f1 = (0.2507, 0.3759, 0.3533, 0.3646)
    measured_timing_f1 = tuple(
        condition["timingAndMismatchScore"]["score"]
        for condition in result["aggregate"].values()
    )
    assert measured_timing_f1 == expected_timing_f1
    published_values = tuple(
        f"{value:.4f}" for value in (*expected_f1, *expected_timing_f1)
    )
    for path in (
        "docs/TRANSCRIPTION_METHOD_BENCHMARK.md",
        "docs/TRANSCRIPTION_METHOD_BENCHMARK.en.md",
    ):
        document = (REPOSITORY_ROOT / path).read_text(encoding="utf-8")
        assert all(value in document for value in published_values), path


def test_current_routing_benchmark_records_product_settings() -> None:
    data_directory = REPOSITORY_ROOT / "docs/benchmarks/data"
    product_gains = {
        "bass": 0.2,
        "piano": 0.2,
        "guitar": 0.2,
        "vocals": 0.2,
        "other": 0.2,
    }
    routing = json.loads(
        (data_directory / "babyslakh-medium-fp16-routing-policy.json")
        .read_text(encoding="utf-8")
    )
    assert routing["configuration"]["timingGuideGains"] == product_gains
    assert routing["configuration"]["timingGuideNoteFilterByGuideScope"] == {
        "none": False,
        "pitched": True,
        "all": True,
    }
    assert routing["aggregate"]["pitchOnly"]["fixedMetadataPitchedGuide"][
        "score50Ms"
    ]["microF1"] == 0.5411
    assert routing["aggregate"]["instrumentAware"][
        "fixedMetadataPitchedGuide"
    ]["score50Ms"]["microF1"] == 0.4653


def test_public_japanese_transcription_docs_use_defined_terms() -> None:
    documents = {
        path: (REPOSITORY_ROOT / path).read_text(encoding="utf-8")
        for path in (
            "README.md",
            "docs/USER_GUIDE.md",
            "docs/TRANSCRIPTION_METHOD_BENCHMARK.md",
        )
    }
    undefined_or_ambiguous_terms = (
        "1回目",
        "2回目",
        "主採譜",
        "検証用採譜",
        "正本",
        "conditioned",
        "automatic",
        "remainder再確認",
        "公開用other",
        "旧方式",
        "現方式",
        "従来",
    )
    for path, document in documents.items():
        for term in undefined_or_ambiguous_terms:
            assert term not in document, (path, term)

    user_guide = documents["docs/USER_GUIDE.md"]
    for required_text in (
        "6成分を個別WAVとして保存",
        "音源分離後の発音開始時刻の誤差を低減する",
        "分離後音源の音量からベロシティを設定する",
        "ドラム成分の追加による音高の誤検出を削減する",
    ):
        assert required_text in user_guide

def test_user_guides_define_cache_retention() -> None:
    japanese = (REPOSITORY_ROOT / "docs/USER_GUIDE.md").read_text(
        encoding="utf-8"
    )
    english = (REPOSITORY_ROOT / "docs/USER_GUIDE.en.md").read_text(
        encoding="utf-8"
    )
    normalized_english = " ".join(english.split())

    for text in (
        "解析用音声、分離音源、採譜結果の最終使用時刻が新しい10件を保持",
        "`UserData`は`EarCopyAssist.exe`と同じ場所",
        "使用量の確認と選択削除",
    ):
        assert text in japanese
    for text in (
        "retains the 10 most recently used analysis-audio, separated-audio, and transcription entries",
        "The `UserData` folder beside `EarCopyAssist.exe` stores the cache",
        "view storage use and delete selected entries",
    ):
        assert text in normalized_english


def test_user_guides_describe_current_input_editing_and_export_behavior() -> None:
    japanese = (REPOSITORY_ROOT / "docs/USER_GUIDE.md").read_text(
        encoding="utf-8"
    )
    english = (REPOSITORY_ROOT / "docs/USER_GUIDE.en.md").read_text(
        encoding="utf-8"
    )

    for extension in ("WAV", "MP3", "FLAC", "Ogg", "M4A", "AAC"):
        assert extension in japanese
        assert extension in english
    for text in (
        "日本語、英語、中国語",
        "すべての音符の開始位置と終了位置",
        "MIDIは、画面上の音符の開始位置と終了位置をそのまま使用します",
        "モードボタンを押すたびに、Mute／Solo状態を表の内容へ初期化します",
        "Solo中の採譜トラックを追加でMuteできます",
        "採譜トラックと対応する分離音源のMute／Soloは同時に切り替わります",
    ):
        assert text in japanese
    for text in (
        "Japanese, English, or Chinese",
        "move every note start and end",
        "MIDI uses the note start and end positions shown in the editor",
        "Selecting a mode resets the Mute and Solo states",
        "a transcription track selected for Solo can also be muted",
        "Mute and Solo change together for a transcription track and its corresponding separated component",
    ):
        assert text in english
    for document in (japanese, english):
        assert "all_window.png" not in document
        assert "saifu_solo.png" not in document


def test_release_readme_describes_selectable_interface_languages() -> None:
    release_readme = (
        REPOSITORY_ROOT / "app/packaging/release/README.txt"
    ).read_text(encoding="utf-8")
    assert "日本語、英語、中国語" in release_readme
    assert "Japanese, English, or Chinese" in release_readme
    assert "The current application interface is Japanese" not in (
        release_readme
    )

    release_notes = (
        REPOSITORY_ROOT / "app/packaging/release/RELEASE_NOTES.md"
    ).read_text(encoding="utf-8")
    for text in (
        "日本語、英語、中国語",
        "Japanese, English, and Chinese display languages",
    ):
        assert text in release_notes
    for obsolete_text in (
        "外れ拍に影響されにくい",
        "半音経過音に影響されにくい",
        "High-quality",
        "less sensitive",
        "linked Mute and Solo",
    ):
        assert obsolete_text not in release_notes


def test_release_instructions_use_action_oriented_wording() -> None:
    documents = {
        path: (REPOSITORY_ROOT / path).read_text(encoding="utf-8")
        for path in (
            "README.md",
            "README.en.md",
            "docs/USER_GUIDE.md",
            "docs/USER_GUIDE.en.md",
            "app/packaging/release/README.txt",
            "app/packaging/release/RELEASE_NOTES.md",
        )
    }
    prohibited_reminders = (
        "インストーラーはありません",
        "起動のたびにZIPを展開する処理はありません",
        "モデル重みは含まれません",
        "ログインは代行しません",
        "コード署名されていません",
        "There is no installer",
        "No archive is extracted",
        "Model weights are not included",
        "it does not download models",
        "application is not code-signed",
    )
    for path, document in documents.items():
        for reminder in prohibited_reminders:
            assert reminder not in document, (path, reminder)


def test_notices_identify_bundled_assets_and_redistribution_constraints() -> None:
    notices = (REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md").read_text(
        encoding="utf-8"
    )
    for required_text in (
        "CC BY-NC 4.0",
        "Copyright (c) 2026 Kyutai x Mirelo",
        "https://github.com/muscriptor/muscriptor",
        "初期版で参照した範囲：音符イベント表示、ピアノロール、原音・SoundFont同期再生の設計",
        "モデル重みのライセンス表示：`Unknown`",
        "699412152",
        "ad54168acf271482ad51702953e162a385b8fdcb",
        "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
        "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
        "GNU Lesser General Public License version 2.1 or later",
        "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
        "3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e",
        "9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44",
        "scripts/build_ffmpeg_lgpl.ps1",
        "scripts/build_libsndfile_lgpl.ps1",
        "EarCopyAssist-<version>-copyleft-sources.zip",
        "Apache-2.0",
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
    assert "Copyright (c) 2026 Kyutai x Mirelo" in compact_notices
    assert "MuScriptor/LICENSE" in compact_notices
    assert "MuScriptor/MODEL_NOTICE.txt" in compact_notices
    assert "bundled without modification" in compact_notices
    assert "BS-RoFormer SW Fixed model weight (not bundled)" in (
        compact_notices
    )
    assert "FFmpeg 8.1.2 minimal build: GNU LGPL version 2.1 or later" in (
        compact_notices
    )
    assert "HT-Demucs" not in compact_notices
    assert "SpessaSynth Core and SpessaSynth Lib: MIT License" not in (
        compact_notices
    )

    muscriptor_license = (
        REPOSITORY_ROOT
        / "app"
        / "resources"
        / "licenses"
        / "MuScriptor"
        / "LICENSE"
    ).read_text(encoding="utf-8")
    assert "Copyright (c) 2026 Kyutai x Mirelo" in muscriptor_license
    assert "Permission is hereby granted" in muscriptor_license

    muscriptor_notice = (
        REPOSITORY_ROOT
        / "app"
        / "resources"
        / "licenses"
        / "MuScriptor"
        / "README.md"
    ).read_text(encoding="utf-8")
    assert "https://github.com/muscriptor/muscriptor" in muscriptor_notice
    assert "official MuScriptor Web UI" in muscriptor_notice

    model_notice = (
        REPOSITORY_ROOT
        / "app"
        / "resources"
        / "licenses"
        / "MuScriptor"
        / "MODEL_NOTICE.txt"
    ).read_text(encoding="utf-8")
    for required_text in (
        "Creators: Kyutai and Mirelo",
        "https://creativecommons.org/licenses/by-nc/4.0/",
        "Warranty disclaimer: Section 5",
        "https://huggingface.co/MuScriptor/muscriptor-small",
        "https://huggingface.co/MuScriptor/muscriptor-medium",
        "https://huggingface.co/MuScriptor/muscriptor-large",
        "without modification",
    ):
        assert required_text in model_notice


def test_notice_versions_match_lockfiles() -> None:
    japanese = (REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.md").read_text(
        encoding="utf-8"
    )
    english = (REPOSITORY_ROOT / "THIRD_PARTY_NOTICES.en.md").read_text(
        encoding="utf-8"
    )

    def inventory(document: str) -> dict[str, str]:
        return {
            name.strip(): version.strip()
            for name, version in re.findall(
                r"^\| ([^|]+) \| ([^|]+) \|",
                document,
                flags=re.MULTILINE,
            )
            if name.strip() not in {"Package", "パッケージ"}
        }

    japanese_inventory = inventory(japanese)
    english_inventory = inventory(english)
    assert japanese_inventory == english_inventory

    python_lock = tomllib.loads(
        (REPOSITORY_ROOT / "uv.lock").read_text(encoding="utf-8")
    )

    def normalized_package_name(name: str) -> str:
        return re.sub(r"[-_.]+", "-", name).lower()

    python_versions: dict[str, set[str]] = {}
    for package in python_lock["package"]:
        if "version" not in package:
            continue
        name = normalized_package_name(package["name"])
        python_versions.setdefault(name, set()).add(package["version"])

    package_lock = json.loads(
        (REPOSITORY_ROOT / "app" / "package-lock.json").read_text(
            encoding="utf-8"
        )
    )
    javascript_packages = {
        "Electron": "electron",
        "React": "react",
        "React DOM": "react-dom",
        "scheduler": "scheduler",
        "Lucide React": "lucide-react",
        "OpenSheetMusicDisplay": "opensheetmusicdisplay",
        "JSZip": "jszip",
        "loglevel": "loglevel",
        "typescript-collections": "typescript-collections",
        "VexFlow": "vexflow",
        "spessasynth_core": "spessasynth_core",
        "spessasynth_lib": "spessasynth_lib",
    }
    for display_name, package_name in javascript_packages.items():
        locked_version = package_lock["packages"][
            f"node_modules/{package_name}"
        ]["version"]
        assert japanese_inventory[display_name] == locked_version

    for package_name, documented_version in japanese_inventory.items():
        if package_name in javascript_packages or package_name == "CPython":
            continue
        normalized_name = normalized_package_name(package_name)
        assert normalized_name in python_versions
        assert documented_version in python_versions[normalized_name]

    soxr_package = next(
        package
        for package in python_lock["package"]
        if package["name"] == "soxr"
    )
    windows_wheel = next(
        wheel
        for wheel in soxr_package["wheels"]
        if wheel["url"].endswith("win_amd64.whl")
    )
    wheel_sha256 = windows_wheel["hash"].removeprefix("sha256:")
    for notices in (japanese, english):
        assert windows_wheel["url"] in notices
        assert wheel_sha256 in notices


def test_backend_start_waits_for_renderer_request() -> None:
    main_process = (
        REPOSITORY_ROOT / "app" / "electron" / "main.ts"
    ).read_text(encoding="utf-8")
    create_window = main_process.split(
        "async function createWindow(): Promise<void> {", 1
    )[1].split("async function runShutdownSmokeTest", 1)[0]
    assert "serviceManager.start()" not in create_window
    assert (
        'ipcMain.handle("service:get-connection", async () => '
        "serviceManager.start())"
    ) in main_process


def test_portable_build_includes_release_documents() -> None:
    package = json.loads(
        (REPOSITORY_ROOT / "app" / "package.json").read_text(encoding="utf-8")
    )
    scripts = package["scripts"]
    assert "assert:app-stopped" in scripts["dist:win"]
    assert "build:icon" in scripts["dist:win"]
    assert "verify:muscriptor-models" not in scripts["dist:win"]
    assert "release-staging" in scripts["dist:win"]
    assert "promote-packaged-build.ps1" in scripts["dist:win"]
    assert "assert:app-stopped" in scripts["package:release"]
    assert "verify:release" in scripts["package:release"]
    assert "assert:app-stopped" in scripts["smoke:packaged"]
    assert "verify-release-package.ps1" in scripts["verify:release"]
    assert package["build"]["win"]["icon"] == "resources/icon.ico"

    icon_script = (
        REPOSITORY_ROOT / "scripts" / "build_app_icon.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "EARCOPY_REUSE_TRACKED_ICON",
        "Reusing tracked application icon",
        "Format32bppArgb",
        "ImageFormat]::Png",
        "[uint32]22",
        "icon.ico",
    ):
        assert required_text in icon_script

    promotion_script = (
        REPOSITORY_ROOT
        / "app"
        / "packaging"
        / "promote-packaged-build.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        ".packaging.lock",
        "assert-app-not-running.ps1",
        "release-staging",
        "win-unpacked.previous",
    ):
        assert required_text in promotion_script

    resources = {
        entry["to"]: entry["from"]
        for entry in package["build"]["extraResources"]
    }
    assert resources["licenses/EarCopy_Assist_LICENSE.txt"] == "../LICENSE"
    assert resources["licenses/THIRD_PARTY_NOTICES.md"] == (
        "../THIRD_PARTY_NOTICES.md"
    )
    assert resources["licenses/THIRD_PARTY_NOTICES.en.md"] == (
        "../THIRD_PARTY_NOTICES.en.md"
    )
    assert "models/muscriptor" not in resources
    model_verifier = (
        REPOSITORY_ROOT
        / "app"
        / "packaging"
        / "verify-muscriptor-models.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "411888600",
        "1228144472",
        "5465642136",
        'model_type -ne "muscriptor"',
        "model.safetensors",
        "config.json",
        '[ValidateSet("small", "medium", "large")]',
    ):
        assert required_text in model_verifier
    assert "licenses/DISTRIBUTION.md" not in resources

    packaged_smoke_test = (
        REPOSITORY_ROOT / "app" / "scripts" / "smoke-packaged.cjs"
    ).read_text(encoding="utf-8")
    for required_text in (
        'const bundledMuScriptorVariants = ["small", "medium", "large"]',
        "MuScriptor ${variant}が本体アーカイブに含まれています",
        'console.log("packaged-muscriptor-models: absent")',
    ):
        assert required_text in packaged_smoke_test
    assert "statSync(weightPath).size" not in packaged_smoke_test
    assert "EARCOPY_SMOKE_REQUIRE_MODELS" not in packaged_smoke_test

    specification = (
        REPOSITORY_ROOT / "app" / "packaging" / "earcopy_service.spec"
    ).read_text(encoding="utf-8")
    for distribution in (
        "muscriptor",
        "rotary-embedding-torch",
        "torch",
        "soxr",
    ):
        assert f'"{distribution}"' in specification
    assert '"demucs"' not in specification
    assert "collect_distribution_licenses" in specification
    assert "excluded_muscriptor_media_extensions" in specification
    for extension in (".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"):
        assert f'"{extension}"' in specification
    assert '"ffmpeg-lgpl" / "bin"' in specification
    assert '"libsndfile-lgpl" / "bin"' in specification
    assert "libsndfile_binaries + muscriptor_binaries" in specification
    assert 'shutil.which("ffmpeg")' not in specification

    build_script = (
        REPOSITORY_ROOT / "scripts" / "build_ffmpeg_lgpl.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "--disable-gpl",
        "--disable-nonfree",
        "--disable-autodetect",
        "--extra-ldflags=-static",
        "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
    ):
        assert required_text in build_script

    libsndfile_build_script = (
        REPOSITORY_ROOT / "scripts" / "build_libsndfile_lgpl.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "-DENABLE_EXTERNAL_LIBS=OFF",
        "-DENABLE_MPEG=OFF",
        "3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e",
        "libsndfile_x64.dll",
        "$documentedConfigureOptions",
        "<source>/libsndfile-$Version",
        "<mingw64>/bin/gcc.exe",
    ):
        assert required_text in libsndfile_build_script

    release_script = (
        REPOSITORY_ROOT / "app" / "packaging" / "build-release-package.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "EarCopyAssist-$version-copyleft-sources",
        "$portableName.zip",
        "New-SplitZipArchive",
        '$splitPartSize = "1800m"',
        "Get-InfoZipExecutable",
        "Info-ZIP",
        "EARCOPY_ZIP_EXECUTABLE",
        "BUILD_INFO.txt",
        "THIRD_PARTY_NOTICES.en.md",
        "docs\\USER_GUIDE.md",
        "docs\\USER_GUIDE.en.md",
        "Unexpected model weights found in the release package",
        "GitHub Release asset must be smaller than 2 GiB",
        "status --porcelain --untracked-files=no",
        "$ApplicationRoot",
        'Write-Host "Downloading corresponding source:',
        '${SOURCE_COMMIT}',
    ):
        assert required_text in release_script
    assert "$allowedWeightPaths" not in release_script
    assert "resources\\models\\muscriptor\\small\\model.safetensors" not in release_script
    assert 'Write-Output "Downloading corresponding source:' not in release_script

    release_verifier = (
        REPOSITORY_ROOT
        / "app"
        / "packaging"
        / "verify-release-package.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "SHA256SUMS.txt",
        "BUILD_INFO.txt",
        "Source commit:",
        "model weights",
        "UserData",
        "githubAssetLimit",
        "Get-InfoZipExecutable",
        "Unable to reconstruct the standard split Windows ZIP.",
        "ffmpeg-8.1.2.tar.xz",
        "libsndfile-1.2.2.tar.xz",
        "soxr-1.1.0.tar.gz",
        "Local absolute path found in packaged libsndfile build information.",
        "Private data, user files, or unexpected model weights found in Windows archive",
        "Sensitive text",
        "absolute Windows user path",
        "private key",
        "GitHub fine-grained token",
        "Windows SID",
        "phone number",
        "Non-loopback IPv4 address",
    ):
        assert required_text in release_verifier
    assert "$allowedModelWeights" not in release_verifier
    assert "resources/models/muscriptor/small/model.safetensors" not in release_verifier

    release_notes = (
        REPOSITORY_ROOT
        / "app"
        / "packaging"
        / "release"
        / "RELEASE_NOTES.md"
    ).read_text(encoding="utf-8")
    for required_text in (
        "${SOURCE_COMMIT}",
        "win-x64.z01",
        "win-x64.zip",
        "muscriptor-small.zip",
        "muscriptor-medium.zip",
        "muscriptor-large.z01",
        "muscriptor-large.zip",
        "7-Zip",
        "FFmpeg",
        "GNU LGPL version 2.1 or later",
        "copyleft-sources.zip",
    ):
        assert required_text in release_notes

    assert not (
        REPOSITORY_ROOT / "app" / "packaging" / "release" / "EXTRACT.cmd"
    ).exists()
    for obsolete_marker in ("RUNTIME_PART_1.txt", "RUNTIME_PART_2.txt"):
        assert not (
            REPOSITORY_ROOT / "app" / "packaging" / "release" / obsolete_marker
        ).exists()

    release_template = REPOSITORY_ROOT / "app" / "packaging" / "release"
    assert not (release_template / "SETUP_MODELS.cmd").exists()
    assert not (release_template / "setup-models.ps1").exists()
    direct_download_files = {
        "models/bs-roformer/sw-fixed/PLACE_MODEL_FILES_HERE.txt": (
            "BS-ROFO-SW-Fixed/resolve/ad54168acf271482ad51702953e162a385b8fdcb/BS-Rofo-SW-Fixed.ckpt?download=true",
            "Unknown",
            "699412152 bytes",
            "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
        ),
    }
    for relative_path, required_texts in direct_download_files.items():
        contents = (release_template / relative_path).read_text(encoding="utf-8")
        assert all(text in contents for text in required_texts)

def test_ci_and_native_build_configuration() -> None:
    release_workflow_path = (
        REPOSITORY_ROOT / ".github" / "workflows" / "windows-release.yml"
    )
    release_workflow = release_workflow_path.read_text(encoding="utf-8")
    for required_text in (
        "workflow_dispatch:",
        "resume_release:",
        "publish_existing_release:",
        "runs-on: windows-latest",
        "environment: windows-release",
        "actions/cache/restore",
        "actions/cache/save",
        "prepare-muscriptor-models:",
        "needs: prepare-muscriptor-models",
        "restore_ci_muscriptor_model_source.ps1",
        "remove_ci_muscriptor_model_sources.ps1",
        "publish-muscriptor-models:",
        "publish_ci_muscriptor_model.ps1",
        "muscriptor-small-${{ runner.os }}",
        "muscriptor-medium-${{ runner.os }}",
        "muscriptor-large-${{ runner.os }}",
        "steps.setup_msys2.outputs.msys2-location",
        "EARCOPY_MSYS2_ROOT",
        "EARCOPY_ZIP_EXECUTABLE",
        "cleanup_ci_release_build.ps1 -Phase BeforeBuild",
        "cleanup_ci_release_build.ps1 -Phase AfterPackaging",
        "Remove unused native WebGL module",
        "node_modules\\gl",
        "npm run smoke:packaged",
        "build-release-package.ps1",
        "verify-release-package.ps1",
        "publish_draft_release.ps1",
        "publish-release:",
        "publish_github_release.ps1",
        "cancel-in-progress: false",
        "always() && !inputs.publish_existing_release && (inputs.resume_release || needs.build.result == 'success')",
        "always() && (inputs.publish_existing_release || needs.publish-muscriptor-models.result == 'success')",
    ):
        assert required_text in release_workflow
    assert "pull_request:" not in release_workflow
    assert "\n  push:" not in release_workflow
    assert "huggingface.co" not in release_workflow.lower()
    assert "self-hosted" not in release_workflow
    assert "MUSCRIPTOR_MODEL_ROOT" not in release_workflow
    assert "earcopy-release" not in release_workflow

    model_publisher = (
        REPOSITORY_ROOT / "scripts" / "publish_ci_muscriptor_model.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        '[ValidateSet("small", "medium", "large")]',
        "HF_TOKEN",
        "curl.exe",
        "verify-muscriptor-models.ps1",
        "HardLink",
        "main/${fileName}?download=true",
        "-s 1800m",
        "EARCOPY_UNZIP_EXECUTABLE",
        "unzip.exe",
        "-s- $archive -O $verificationArchive",
        "-t $verificationArchive",
        '"$assetBaseName-verification.zip"',
        "gh release upload",
        "SHA256SUMS.txt",
        "Refusing to modify a published release",
    ):
        assert required_text in model_publisher
    assert not (
        REPOSITORY_ROOT / "scripts" / "stage_ci_muscriptor_models.ps1"
    ).exists()
    assert not (
        REPOSITORY_ROOT / "scripts" / "download_ci_muscriptor_models.py"
    ).exists()

    source_preparer = (
        REPOSITORY_ROOT / "scripts" / "prepare_muscriptor_release_sources.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "verify-muscriptor-models.ps1",
        '"small", "medium", "large"',
        '"-t7z", "-mx=0"',
        '"-v1800m"',
        '"model.safetensors", "config.json"',
        "$SevenZipExecutable t $testArchive",
    ):
        assert required_text in source_preparer

    source_restorer = (
        REPOSITORY_ROOT / "scripts" / "restore_ci_muscriptor_model_source.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "gh release download",
        "muscriptor-source-$Variant.7z",
        "$sevenZipPath t $testArchive",
        "$sevenZipPath x $testArchive",
        "verify-muscriptor-models.ps1",
    ):
        assert required_text in source_restorer

    source_remover = (
        REPOSITORY_ROOT / "scripts" / "remove_ci_muscriptor_model_sources.ps1"
    ).read_text(encoding="utf-8")
    assert "gh release delete-asset" in source_remover
    assert "muscriptor-source-(small|medium|large)" in source_remover

    ci_workflow = (
        REPOSITORY_ROOT / ".github" / "workflows" / "ci.yml"
    ).read_text(encoding="utf-8")
    assert "actions/setup-node@v6" in ci_workflow
    assert "actions/setup-node@v4" not in ci_workflow
    assert 'branches:\n      - "**"' in ci_workflow
    assert "npm run build:electron" in ci_workflow
    assert "npm run smoke:shutdown" in ci_workflow

    ffmpeg_build = (
        REPOSITORY_ROOT / "scripts" / "build_ffmpeg_lgpl.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "Build script SHA-256: $scriptSha256",
        "Assert-LgplConfiguration -Executable $ffmpegExecutable",
        "FFmpeg LGPL tools are up to date",
        "Write-SourceOffer",
        "--connect-timeout 30",
        "--max-time 300",
        'Get-Command "7z.exe"',
        '"7-Zip\\7z.exe"',
        'FFmpeg XZ decompression',
        'FFmpeg TAR extraction',
        '$process.WaitForExit($TimeoutSeconds * 1000)',
        "ConvertTo-WindowsProcessArgument",
        'Select-String -Pattern "DLL Name:"',
        "Executable depends on a MinGW runtime DLL",
        'startInfo.Environment["PATH"]',
        'startInfo.EnvironmentVariables["PATH"]',
        "FFmpeg functional conversion",
        "FFprobe functional validation",
        "Assert-BuiltTools",
        "Portable launch and functional conversion passed",
        'export HOME=',
        "Invoke-MsysCommand",
        '-Description "FFmpeg configure"',
        "-TimeoutSeconds 300",
        '-Description "FFmpeg build"',
        "-TimeoutSeconds 900",
        'Write-BuildStage -Stage "configure"',
        'Write-BuildStage -Stage "compile"',
        "EARCOPY_MSYS2_ROOT",
        'Join-Path $msys2Root "mingw64\\bin\\objdump.exe"',
    ):
        assert required_text in ffmpeg_build

    libsndfile_build = (
        REPOSITORY_ROOT / "scripts" / "build_libsndfile_lgpl.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        'Write-BuildStage -Stage "download"',
        'Write-BuildStage -Stage "extract"',
        'Write-BuildStage -Stage "configure"',
        'Write-BuildStage -Stage "compile"',
        'Write-BuildStage -Stage "validate"',
        "Invoke-ProcessWithTimeout",
        "Resolve-SevenZip",
        '$env:Path = "$mingwBin;$env:Path"',
        '"--connect-timeout", "30"',
        '"--max-time", "120"',
        'libsndfile XZ decompression',
        'libsndfile TAR extraction',
        '-TimeoutSeconds 180',
        '-TimeoutSeconds 300',
        "EARCOPY_MSYS2_ROOT",
        'Join-Path $msys2Root "mingw64\\bin\\gcc.exe"',
    ):
        assert required_text in libsndfile_build

    cleanup = (
        REPOSITORY_ROOT / "scripts" / "cleanup_ci_release_build.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        '[ValidateSet("BeforeBuild", "AfterPackaging")]',
        "GITHUB_ACTIONS",
        "GITHUB_WORKSPACE",
        "models\\muscriptor\\small\\model.safetensors",
        "models\\muscriptor\\medium\\model.safetensors",
        "models\\muscriptor\\large\\model.safetensors",
        "Refusing to remove a path outside the repository",
    ):
        assert required_text in cleanup

    release_publisher = (
        REPOSITORY_ROOT / "scripts" / "publish_draft_release.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "Refusing to modify a published release",
        "gh release create",
        "--draft",
        "gh release upload",
        "--clobber",
        "SHA256SUMS.txt",
        "muscriptor-source-(small|medium|large)",
    ):
        assert required_text in release_publisher

    final_release_publisher = (
        REPOSITORY_ROOT / "scripts" / "publish_github_release.ps1"
    ).read_text(encoding="utf-8")
    for required_text in (
        "Draft release was not found",
        "SHA256SUMS does not match draft release assets",
        "Large model ZIP volume numbering is incomplete",
        "gh release download",
        "gh release edit $tag",
        "--draft=false",
    ):
        assert required_text in final_release_publisher


def test_ci_powershell_scripts_parse() -> None:
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if powershell is None:
        pytest.skip("PowerShell is not available")

    parser_command = r"""
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $env:EARCOPY_PARSE_TARGET,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -ne 0) {
    $errors | ForEach-Object { Write-Error $_.Message }
    exit 1
}
"""
    script_paths = (
        REPOSITORY_ROOT / "scripts" / "build_ffmpeg_lgpl.ps1",
        REPOSITORY_ROOT / "scripts" / "build_libsndfile_lgpl.ps1",
        REPOSITORY_ROOT / "scripts" / "cleanup_ci_release_build.ps1",
        REPOSITORY_ROOT / "scripts" / "publish_draft_release.ps1",
        REPOSITORY_ROOT / "scripts" / "publish_ci_muscriptor_model.ps1",
        REPOSITORY_ROOT / "scripts" / "prepare_muscriptor_release_sources.ps1",
        REPOSITORY_ROOT / "scripts" / "restore_ci_muscriptor_model_source.ps1",
        REPOSITORY_ROOT / "scripts" / "remove_ci_muscriptor_model_sources.ps1",
        REPOSITORY_ROOT / "scripts" / "publish_github_release.ps1",
        REPOSITORY_ROOT / "app" / "packaging" / "verify-muscriptor-models.ps1",
    )
    for script_path in script_paths:
        environment = os.environ.copy()
        environment["EARCOPY_PARSE_TARGET"] = str(script_path)
        completed = subprocess.run(
            [powershell, "-NoProfile", "-Command", parser_command],
            capture_output=True,
            check=False,
            env=environment,
            text=True,
        )
        assert completed.returncode == 0, (
            f"{script_path}\n{completed.stdout}\n{completed.stderr}"
        )


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


def test_model_destination_guides_include_download_sources() -> None:
    development_guides = {
        "bs-roformer/sw-fixed/PLACE_MODEL_FILES_HERE.txt": (
            "BS-Rofo-SW-Fixed.ckpt",
            "https://huggingface.co/jarredou/BS-ROFO-SW-Fixed/resolve/ad54168acf271482ad51702953e162a385b8fdcb/BS-Rofo-SW-Fixed.ckpt?download=true",
            "Unknown",
            "699412152 bytes",
            "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
        ),
        "muscriptor/small/PLACE_MODEL_FILES_HERE.txt": (
            "model.safetensors",
            "config.json",
            "https://huggingface.co/MuScriptor/muscriptor-small/resolve/main/model.safetensors?download=true",
            "https://huggingface.co/MuScriptor/muscriptor-small/resolve/main/config.json?download=true",
        ),
        "muscriptor/medium/PLACE_MODEL_FILES_HERE.txt": (
            "model.safetensors",
            "config.json",
            "https://huggingface.co/MuScriptor/muscriptor-medium/resolve/main/model.safetensors?download=true",
            "https://huggingface.co/MuScriptor/muscriptor-medium/resolve/main/config.json?download=true",
        ),
        "muscriptor/large/PLACE_MODEL_FILES_HERE.txt": (
            "model.safetensors",
            "config.json",
            "https://huggingface.co/MuScriptor/muscriptor-large/resolve/main/model.safetensors?download=true",
            "https://huggingface.co/MuScriptor/muscriptor-large/resolve/main/config.json?download=true",
        ),
    }
    for relative_path, required_texts in development_guides.items():
        guide = (REPOSITORY_ROOT / "models" / relative_path).read_text(
            encoding="utf-8"
        )
        for required_text in required_texts:
            assert required_text in guide

    release_models = (
        REPOSITORY_ROOT / "app" / "packaging" / "release" / "models"
    )
    bs_guide = release_models / "bs-roformer/sw-fixed/PLACE_MODEL_FILES_HERE.txt"
    assert "BS-Rofo-SW-Fixed.ckpt" in bs_guide.read_text(encoding="utf-8")
    for variant in ("small", "medium", "large"):
        assert not (
            release_models
            / f"muscriptor/{variant}/PLACE_MODEL_FILES_HERE.txt"
        ).exists()
