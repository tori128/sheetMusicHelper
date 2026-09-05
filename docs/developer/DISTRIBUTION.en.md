# Release and Distribution Checklist

[日本語](DISTRIBUTION.md)

This document is not legal advice. The publisher should consult a qualified professional for the applicable regions and distribution method.

## Publishing the Source Repository

1. Run `git status --ignored` and confirm zero tracked files under `models/` and `UserData/`, zero tracked `.ecaproj` and audio files, and zero tracked generated executables.
2. Include `LICENSE`, the Japanese and English README files, user guides, third-party notices, this checklist, and lockfiles.
3. Tag the release commit and state test results, known defects, and usage limitations in the release notes.
4. The application is licensed under the MIT License. Keep [`LICENSE`](../../LICENSE), the [README](../../README.en.md), the [User Guide](../USER_GUIDE.en.md), their Japanese versions, package information, and the in-package license display consistent.

## Publishing the Windows Version

Confirm that every published artifact meets the following requirements.

### Source-Separation Model

The recommended model is BS-RoFormer SW Fixed. The Music-Source-Separation-Training implementation is MIT-licensed, but the checkpoint distribution page does not state weight-specific license terms and displays `Unknown`. When the model is absent, the application displays this warning and the file information, then downloads the model from Hugging Face after user acknowledgement.

- Model page:
  <https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/tree/main>
- File size: `699412152` bytes
- SHA-256:
  `24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e`

Pre-release validation checks the size, SHA-256, and configuration of the MuScriptor small, medium, and large weight and configuration files in the self-extracting model ZIP files.

The distribution decisions are as follows.

- BS-RoFormer SW Fixed: downloaded after the in-application warning is acknowledged and excluded from the Windows application package.
- MuScriptor small, medium, and large: distributed without modification as self-extracting ZIP files on the same GitHub Release because CC BY-NC 4.0 permits reproduction and sharing for non-commercial purposes.

### LGPL Components

The package contains a minimal Windows build of FFmpeg 8.1.2 created from official source with `scripts/build_ffmpeg_lgpl.ps1`. GPL, nonfree features, and external libraries are disabled; only the audio formats and Wave output used by EarCopy Assist are enabled. This configuration is licensed under GNU LGPL version 2.1 or later.

- Official FFmpeg source:
  <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>
- Source SHA-256:
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- Build script: `scripts/build_ffmpeg_lgpl.ps1`

The Python backend also contains libsndfile 1.2.2 and Python-SoXR 1.1.0, both under GNU LGPL version 2.1 or later.

- Official libsndfile source:
  <https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz>
- libsndfile source SHA-256:
  `3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e`
- libsndfile build script: `scripts/build_libsndfile_lgpl.ps1`
- Official Python-SoXR source:
  <https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz>
- Python-SoXR source SHA-256:
  `9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44`

The publisher performs the following steps.

1. Retain `FFmpeg/LICENSE`, `FFmpeg/COPYING.LGPLv3`, `FFmpeg/LICENSE.md`, `FFmpeg/README.txt`, and the libsndfile and SoXR license texts collected from the Python packages in the distribution directory.
2. Publish `EarCopyAssist-<version>-copyleft-sources.zip`, containing verified official source for all three components and the FFmpeg and libsndfile build procedures, on the same GitHub Release as the Windows binaries.
3. Confirm that versions, source SHA-256 values, and build settings match across `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_NOTICES.en.md`, and `README.txt` in the corresponding-source archive.
4. Compare the FFmpeg configure options with `FFmpeg/README.txt`. After a configuration change, verify the resulting license and corresponding-source requirements.
5. Display the FFmpeg name, GNU LGPL version 2.1 or later, and the corresponding-source ZIP filename in the GitHub Release description.

This method publishes complete source for the LGPL components beside the binaries. Preserve access to the corresponding source for the distributed version.

### MuScriptor Models

Distribute the unmodified MuScriptor small, medium, and large weights as self-extracting ZIP files. Users select the parent folder containing the Windows package as the extraction folder to place the files under `models/muscriptor/<variant>/model.safetensors`. Public documents and the startup confirmation screen state the following facts.

- The models are restricted to non-commercial use.
- EarCopy Assist terms and model terms are separate.
- The creators are Kyutai and Mirelo.
- State the CC BY-NC 4.0 URI, warranty disclaimer, source page for each model, and absence of modifications.
- State the additional official-model-page terms covering submitted music, generated content, compliance with law, warranty, and indemnification.
- State that users must hold the required rights or permissions for submitted music.

### Dependency Updates

This checklist and the third-party notices state the versions used by EarCopy Assist, rather than the latest versions available upstream.

1. Update `uv.lock` for Python packages and `app/package-lock.json` for JavaScript packages.
2. Update versions, licenses, sources, and required notices in `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_NOTICES.en.md`.
3. Update the distributed `LICENSE`, `COPYING`, and `NOTICE` files.
4. Run the document tests and confirm that lockfiles and Japanese and English notices match.

### Other Bundled Materials

- Retain MuScriptor `LICENSE`, `README.md`, and `MODEL_NOTICE.txt`. Display Copyright (c) 2026 Kyutai x Mirelo for the code; the source, including the official Web UI; the MIT License; model creators; CC BY-NC 4.0; all three model sources; absence of modifications; and warranty disclaimer.
- Retain MuseScore General `LICENSE.md`, `README.md`, `SAMPLE_SOURCES.csv`, `VERSION`, and `SOURCE.md`. Confirm that the SoundFont SHA-256 is `5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3`.
- Retain the Apache-2.0 text for SpessaSynth.
- Retain `LICENSE`, `COPYING`, and `NOTICE` files from Python packages.
- Include Electron `LICENSE.electron.txt` and `LICENSES.chromium.html`.
- Recalculate the SHA-256 values for files identified in `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_NOTICES.en.md` and confirm that they match.

## Release Validation

```powershell
uv sync --extra dev
uv run pytest

.\scripts\build_ffmpeg_lgpl.ps1
.\scripts\build_libsndfile_lgpl.ps1

cd app
npm ci
npm test -- --run
npm run typecheck
npm run dist:win
npm run smoke:packaged
npm run package:release
npm run verify:release
```

`app/release-assets/` contains the following files. The number of Windows volumes depends on compressed size.

- `EarCopyAssist-<version>-win-x64.z01`
- `EarCopyAssist-<version>-win-x64.z02` and later, when present
- `EarCopyAssist-<version>-win-x64.exe`
- `EarCopyAssist-<version>-copyleft-sources.zip`
- `RELEASE_NOTES.md`
- `SHA256SUMS.txt`

Each Release asset must be below 2 GiB. Attach every split Windows volume, the self-extracting ZIP, and the LGPL corresponding-source ZIP to the same Release. Attach the three MuScriptor models as separate self-extracting ZIP files to the same Release, and verify each model weight and `config.json` file.

`package:release` fails when tracked files contain uncommitted changes. The `BUILD_INFO.txt` in the Windows ZIP embedded in the self-extracting ZIP and the release notes record the 40-character source commit. `verify:release` revalidates ZIP-volume numbering, the self-extracting ZIP, reconstruction, SHA-256 for each asset, the 2 GiB limit, path layout, required files, absence of model weights and `UserData`, corresponding source, and the source commit.

### Publishing a Release

The standard `.github/workflows/ci.yml` runs tests that require no model weights, type checking, and the Renderer-unresponsiveness shutdown regression.

#### Packaging with GitHub Actions

`.github/workflows/windows-release.yml` accepts manual dispatch only and uses the GitHub `windows-release` environment. The Windows application package is built on a standard GitHub-hosted Windows runner. Before dispatch, create temporary source archives from the verified local MuScriptor models with `scripts/prepare_muscriptor_release_sources.ps1`, then upload them to the non-public Release for the target tag. The workflow removes those temporary source archives before publishing the Release.

Its first job downloads and extracts the temporary source archives, then validates the size, SHA-256, and configuration of the following six files. A validation failure prevents the Windows application build from starting.

```text
models/muscriptor/
├─ small/
│  ├─ model.safetensors
│  └─ config.json
├─ medium/
│  ├─ model.safetensors
│  └─ config.json
└─ large/
   ├─ model.safetensors
   └─ config.json
```

The six model files total 7,105,675,208 bytes. The workflow stores each validated model directory in GitHub Actions Cache. Later jobs restore one model at a time from that cache and create self-extracting ZIP model assets that meet GitHub Release's 2 GiB per-file limit. The Windows application package contains no model weights.

GitHub Actions configures Node.js 24, Python 3.11, uv, and MSYS2 MINGW64. The workflow passes the actual MSYS2 installation directory to FFmpeg and libsndfile builds as `EARCOPY_MSYS2_ROOT`.

#### Starting CI

The standard CI workflow is `.github/workflows/ci.yml`. Pushing any branch to GitHub starts Python tests, Renderer tests, type checking, Electron main-process compilation, and the Renderer-unresponsiveness shutdown test.

```powershell
git push origin <branch>
```

To start it manually in GitHub, select `CI` under `Actions`, choose `Run workflow`, and select the branch. With GitHub CLI, run:

```powershell
gh workflow run ci.yml --ref <branch>
```

After `.github/workflows/windows-release.yml` is present on the default branch, start Windows packaging manually. In GitHub, select `Windows Release` under `Actions`, choose `Run workflow`, and provide the branch and `release_tag`. A blank `release_tag` uses the version from `app/package.json` prefixed with `v`.

To start the default tag with GitHub CLI:

```powershell
gh workflow run windows-release.yml --ref master
```

To specify a tag:

```powershell
gh workflow run windows-release.yml --ref master -f release_tag=v0.1.0
```

Monitor progress in GitHub `Actions` or with:

```powershell
gh run list --workflow windows-release.yml
gh run watch <run-id> --exit-status
```

On success, the workflow creates a Draft Release for the selected tag. If a Draft Release with that tag exists, it updates the target commit, release notes, and Release assets.

The workflow runs tests, type checking, MuScriptor model validation, FFmpeg and libsndfile builds, Electron packaging, packaged-application startup testing, self-extracting ZIP creation, and Release-asset validation in sequence. On success, it registers every Windows `.zNN` volume, the `.exe`, the corresponding-source ZIP, `RELEASE_NOTES.md`, and `SHA256SUMS.txt` on the same Draft Release. It leaves published Releases unchanged. The publisher reviews artifacts, licenses, and acceptance-test results before publication.

For a local build, place all three MuScriptor models under `models/muscriptor/` on Windows, run the commands above, and register the generated Release assets on a Draft Release.

Before publication, place the complete distribution directory on a clean Windows environment and launch `EarCopyAssist.exe`. Verify startup terms, registration of all three models, transcription, source separation, MIDI and MusicXML export, and the license display.

### Clean Windows Acceptance Test

Creating a clean environment can affect host settings and cost. State the environment, configuration changes, and cost, and obtain approval from the publisher before running these steps.

1. Download every Windows `.zNN` volume, the `.exe`, the corresponding-source ZIP, and `SHA256SUMS.txt` from the GitHub Release, and verify every SHA-256 value.
2. Place every volume and the `.exe` in one directory, run the `.exe`, and confirm extraction to one `EarCopyAssist-<version>-win-x64` directory.
3. Launch the application and confirm that the embedded service remains stopped before accepting the MuScriptor terms and that small, medium, and large appear after acceptance.
4. On the new-project screen, confirm the BS-RoFormer SW Fixed `Unknown` license status, distribution page, 699412152-byte size, destination, and SHA-256. Select the acknowledgement, download the model, and confirm that source-separated transcription becomes available.
5. Using a 30-second audio file with cleared rights, run direct transcription and transcription after source separation. In each process, verify progress, cancellation, editing after cancellation, and chord analysis.
6. Select each playback mode in sequence. Confirm that Source mutes transcription tracks, Transcription mutes the source and separated components, and L/R comparison clears every Mute and Solo state on both sides.
7. Verify multiple Solo selections, additional Mute on a Solo transcription track in Transcription mode, and paired Mute and Solo between transcription tracks and corresponding separated components in L/R comparison. In a project without separated components, confirm that full-source playback continues after transcription-track Mute and Solo operations.
8. Verify note editing, MIDI, MusicXML, separated WAV, and `.ecaproj` save and reload. Confirm that MIDI uses note positions shown in the editor and MusicXML uses the note resolution selected in the export screen.
9. Exit the application and confirm in Task Manager that the process counts for `EarCopyAssist.exe` and `earcopy_service.exe` are both zero.
10. Inspect the license screen, `licenses/`, and the corresponding-source ZIP.

### Code Signing

The current 0.1.0 Authenticode status is `NotSigned`. Purchasing or applying for a signing certificate incurs costs and identity verification, so obtain approval from the publisher before either action. Check the status before and after signing with:

```powershell
.\scripts\check_authenticode.ps1
.\scripts\check_authenticode.ps1 -RequireValid
```

When signing, apply the same publisher certificate and a timestamp to at least the packaged `EarCopyAssist.exe` and the embedded `earcopy_service.exe`. Regenerate the package and rerun checksum and smoke testing after signing.

## User-Processed Audio

Users obtain the required copyright, neighboring-right, and recording-right permissions for submitted recordings and generated stems, MIDI, and MusicXML.
