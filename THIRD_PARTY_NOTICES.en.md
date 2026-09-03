# Third-Party Notices

[日本語](THIRD_PARTY_NOTICES.md)

EarCopy Assist uses third-party software and assets, some of which are
redistributed in its distribution package. The EarCopy Assist project license
does not replace or restrict the licenses listed here.

This document lists the versions actually used by EarCopy Assist and is
updated when those dependencies change.

## Model obtained separately

The BS-RoFormer SW Fixed weight is not included in the Windows application
package. When it is absent, the application displays the distribution page's
`Unknown` license status and downloads it from Hugging Face only after the
user acknowledges that warning. `Unknown` does not constitute a license grant.

## MuScriptor

### Code

- Component: MuScriptor 0.2.2 Python package and official Web UI
- Use in EarCopy Assist: model loading and note-event generation
- Initial implementation reference: note-event display, piano roll, and
  synchronized source/SoundFont playback design
- Copyright: Copyright (c) 2026 Kyutai x Mirelo
- Source: <https://github.com/muscriptor/muscriptor>
- License: MIT
- Bundled license text: `app/resources/licenses/MuScriptor/LICENSE`

### Model weights

The EarCopy Assist GitHub Release distributes the official `small`, `medium`,
and `large` model weights without modification as model archives. They are licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), and use and
redistribution are restricted to non-commercial purposes. The creators are
Kyutai and Mirelo. The official model pages also publish additional conditions
covering input music, generated content, compliance with applicable law,
warranty disclaimers, and indemnification. Users must hold every right or
authorization required for the music they submit. The warranty disclaimer is
in Section 5 of CC BY-NC 4.0. The bundled attribution notice is
`app/resources/licenses/MuScriptor/MODEL_NOTICE.txt`.

- <https://huggingface.co/MuScriptor/muscriptor-small>
- <https://huggingface.co/MuScriptor/muscriptor-medium>
- <https://huggingface.co/MuScriptor/muscriptor-large>
- Modifications: none
- small SHA-256: `bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c`
- medium SHA-256: `ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec`
- large SHA-256: `ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397`

## BS-RoFormer

- Component: BS-RoFormer SW Fixed inference code and model
- Code copyright: Copyright (c) 2024 Roman Solovyev (ZFTurbo)
- Code source:
  <https://github.com/ZFTurbo/Music-Source-Separation-Training>
- Code license: MIT
- Model weight: `BS-Rofo-SW-Fixed.ckpt`
- Trainer: not identified on the distribution page
- Distribution-page uploader: enerjazzer
- Distribution page used by the application:
  <https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/tree/main>
- Weight license shown by the distributor: `Unknown`
- Weight file size: `699412152` bytes
- Weight SHA-256:
  `24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e`

## MuseScore General SoundFont

- Component: `MuseScore_General.sf3`
- Version: 0.2.0
- Upstream: <https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/>
- License: MIT
- SHA-256:
  `5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3`

Required acknowledgements:

- FluidR3: Copyright (c) 2000-2002, 2008 Frank Wen
- FluidR3Mono conversion: Copyright (c) 2014-2017 Michael Cowgill
- MuseScore General adaptation: Copyright (c) 2018-2019 S. Christian Collins
- Temple Blocks: Copyright (c) 2002 Ethan Winer
- Drumline Cymbals: Copyright (c) 2016 Michael Schorsch

The complete supplied notice and MIT text are distributed as
`MuseScore_General/LICENSE.md`.

## FFmpeg and FFprobe

- Component: FFmpeg 8.1.2 minimal static Windows command-line build
- Distribution form: executables built by this project from the official
  source and bundled with the distribution package
- Upstream source: <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>
- Source SHA-256:
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- License for this configured build:
  GNU Lesser General Public License version 2.1 or later
- Reproducible build script: `scripts/build_ffmpeg_lgpl.ps1`
- Build configuration: the bundled `FFmpeg/README.txt`

EarCopy Assist invokes `ffmpeg.exe` and `ffprobe.exe` as separate programs.
They are replaceable files and are built with GPL, nonfree, autodetected, and
external-library features disabled. The LGPL license texts, upstream license
summary, and exact configure options are distributed with the application.

## libsndfile

- Component: libsndfile 1.2.2
- Used through: python-soundfile 0.14.0
- Distribution form: a DLL built by this project from the official source and
  bundled with the distribution package
- Binary: `_soundfile_data/libsndfile_x64.dll`
- Upstream source:
  <https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz>
- Source SHA-256:
  `3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e`
- License: GNU Lesser General Public License version 2.1 or later
- Reproducible build script: `scripts/build_libsndfile_lgpl.ps1`

External codec libraries and MPEG support are disabled because EarCopy Assist
passes only normalized WAV files to libsndfile. The resulting DLL depends only
on Windows system libraries and can be replaced with an interface-compatible
modified build.

## Python-SoXR and libsoxr

- Component: Python-SoXR 1.1.0 with its modified libsoxr
- Distribution form: the prebuilt extension from the official PyPI Windows
  wheel, bundled with the distribution package
- Binary: `soxr/soxr_ext.cp311-win_amd64.pyd`
- Windows wheel:
  <https://files.pythonhosted.org/packages/8f/29/371467eb86c7ba6810df0bfe9409bcd9c52ec5615b111190fafe23e4d2e1/soxr-1.1.0-cp311-cp311-win_amd64.whl>
- Windows wheel SHA-256:
  `ae30c48ac795378cf23ba3c7c640b8ff794af714ac388b9fd6b31a40b39e6e86`
- Corresponding source:
  <https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz>
- Source SHA-256:
  `9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44`
- License: GNU Lesser General Public License version 2.1 or later

## Corresponding source distribution

`EarCopyAssist-<version>-copyleft-sources.zip` contains the verified source
archives for FFmpeg, libsndfile, and Python-SoXR, plus the exact FFmpeg and
libsndfile build scripts used by this project. Publish it on the same GitHub
Release page as the distribution ZIPs. The archive's `README.txt` identifies
each corresponding binary, source URL, SHA-256, and build information.

## Included license documents

Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` are included in
the distribution package.

The packaging process collects available `LICENSE`, `COPYING`, and `NOTICE`
files from runtime Python distributions and exposes them in the application's
license viewer. Some packages include additional notices for bundled native
libraries; those supplied texts remain controlling.

## Runtime dependency inventory

The following inventory lists the packages used at application runtime.

### JavaScript and desktop runtime

| Package | Version | License | Source |
|---|---:|---|---|
| Electron | 43.2.0 | MIT | <https://github.com/electron/electron> |
| React | 19.2.8 | MIT | <https://github.com/facebook/react> |
| React DOM | 19.2.8 | MIT | <https://github.com/facebook/react> |
| scheduler | 0.27.0 | MIT | <https://github.com/facebook/react> |
| Lucide React | 1.31.0 | ISC | <https://github.com/lucide-icons/lucide> |
| OpenSheetMusicDisplay | 1.9.9 | BSD-3-Clause | <https://github.com/opensheetmusicdisplay/opensheetmusicdisplay> |
| JSZip | 3.10.1 | MIT OR GPL-3.0-or-later | <https://github.com/Stuk/jszip> |
| loglevel | 1.9.2 | MIT | <https://github.com/pimterry/loglevel> |
| typescript-collections | 1.3.3 | MIT | <https://github.com/basarat/typescript-collections> |
| VexFlow | 1.2.93 | MIT | <https://github.com/0xfe/vexflow> |
| spessasynth_core | 4.3.15 | Apache-2.0 | <https://github.com/spessasus/spessasynth_core> |
| spessasynth_lib | 4.3.11 | Apache-2.0 | <https://github.com/spessasus/spessasynth_lib> |

### Python runtime

| Package | Version | License | Source |
|---|---:|---|---|
| CPython | 3.11 | PSF-2.0 | <https://github.com/python/cpython> |
| annotated-doc | 0.0.4 | MIT | <https://github.com/fastapi/annotated-doc> |
| annotated-types | 0.8.0 | MIT | <https://github.com/annotated-types/annotated-types> |
| anyio | 4.14.2 | MIT | <https://github.com/agronholm/anyio> |
| audioread | 3.1.0 | MIT | <https://github.com/beetbox/audioread> |
| certifi | 2026.7.22 | MPL-2.0 | <https://github.com/certifi/python-certifi> |
| cffi | 2.1.0 | MIT-0 | <https://github.com/python-cffi/cffi> |
| charset-normalizer | 3.4.9 | MIT | <https://github.com/jawah/charset_normalizer> |
| click | 8.4.2 | BSD-3-Clause | <https://github.com/pallets/click> |
| colorama | 0.4.6 | BSD-3-Clause | <https://github.com/tartley/colorama> |
| decorator | 5.3.1 | BSD-2-Clause | <https://github.com/micheles/decorator> |
| einops | 0.8.2 | MIT | <https://github.com/arogoz/einops> |
| fastapi | 0.140.0 | MIT | <https://github.com/fastapi/fastapi> |
| filelock | 3.32.0 | MIT | <https://github.com/tox-dev/py-filelock> |
| fsspec | 2026.6.0 | BSD-3-Clause | <https://github.com/fsspec/filesystem_spec> |
| h11 | 0.16.0 | MIT | <https://github.com/python-hyper/h11> |
| hf-xet | 1.5.2 | Apache-2.0 | <https://github.com/huggingface/xet-core> |
| httpcore | 1.0.9 | BSD-3-Clause | <https://github.com/encode/httpcore> |
| httptools | 0.8.0 | MIT | <https://github.com/MagicStack/httptools> |
| httpx | 0.28.1 | BSD-3-Clause | <https://github.com/encode/httpx> |
| huggingface-hub | 1.24.0 | Apache-2.0 | <https://github.com/huggingface/huggingface_hub> |
| idna | 3.18 | BSD-3-Clause | <https://github.com/kjd/idna> |
| Jinja2 | 3.1.6 | BSD-3-Clause | <https://github.com/pallets/jinja> |
| joblib | 1.5.3 | BSD-3-Clause | <https://github.com/joblib/joblib> |
| lazy-loader | 0.5 | BSD-3-Clause | <https://github.com/scientific-python/lazy-loader> |
| librosa | 0.11.0 | ISC | <https://github.com/librosa/librosa> |
| llvmlite | 0.48.0 | BSD-2-Clause + third-party notices | <https://github.com/numba/llvmlite> |
| markdown-it-py | 4.2.0 | MIT | <https://github.com/executablebooks/markdown-it-py> |
| MarkupSafe | 3.0.3 | BSD-3-Clause | <https://github.com/pallets/markupsafe> |
| mdurl | 0.1.2 | MIT | <https://github.com/executablebooks/mdurl> |
| mido | 1.3.3 | MIT | <https://github.com/mido/mido> |
| mpmath | 1.3.0 | BSD-3-Clause | <https://github.com/mpmath/mpmath> |
| msgpack | 1.2.1 | Apache-2.0 | <https://github.com/msgpack/msgpack-python> |
| muscriptor | 0.2.2 | MIT | <https://github.com/muscriptor/muscriptor> |
| narwhals | 2.24.0 | MIT | <https://github.com/narwhals-dev/narwhals> |
| networkx | 3.6.1 | BSD-3-Clause | <https://github.com/networkx/networkx> |
| numba | 0.66.0 | BSD | <https://github.com/numba/numba> |
| numpy | 1.26.4 | BSD-3-Clause + bundled notices | <https://github.com/numpy/numpy> |
| packaging | 26.2 | Apache-2.0 OR BSD-2-Clause | <https://github.com/pypa/packaging> |
| platformdirs | 4.11.0 | MIT | <https://github.com/tox-dev/platformdirs> |
| pooch | 1.9.0 | BSD-3-Clause | <https://github.com/fatiando/pooch> |
| pycparser | 3.0 | BSD-3-Clause | <https://github.com/eliben/pycparser> |
| pydantic | 2.13.4 | MIT | <https://github.com/pydantic/pydantic> |
| pydantic-core | 2.46.4 | MIT | <https://github.com/pydantic/pydantic-core> |
| Pygments | 2.20.0 | BSD-2-Clause | <https://github.com/pygments/pygments> |
| python-dotenv | 1.2.2 | BSD-3-Clause | <https://github.com/theskumar/python-dotenv> |
| python-multipart | 0.0.32 | Apache-2.0 | <https://github.com/Kludex/python-multipart> |
| PyYAML | 6.0.3 | MIT | <https://github.com/yaml/pyyaml> |
| requests | 2.34.2 | Apache-2.0 | <https://github.com/psf/requests> |
| rich | 15.0.0 | MIT | <https://github.com/Textualize/rich> |
| rotary-embedding-torch | 0.8.9 | MIT | <https://github.com/lucidrains/rotary-embedding-torch> |
| safetensors | 0.8.0 | Apache-2.0 | <https://github.com/huggingface/safetensors> |
| scikit-learn | 1.9.0 | BSD-3-Clause | <https://github.com/scikit-learn/scikit-learn> |
| scipy | 1.17.1 | BSD-3-Clause + bundled notices | <https://github.com/scipy/scipy> |
| setuptools | 83.0.0 | MIT | <https://github.com/pypa/setuptools> |
| shellingham | 1.5.4 | ISC | <https://github.com/sarugaku/shellingham> |
| soundfile | 0.14.0 | BSD-3-Clause; bundled libsndfile LGPL-2.1-or-later | <https://github.com/bastibe/python-soundfile> |
| soxr | 1.1.0 | LGPL-2.1-or-later + bundled notices | <https://github.com/dofuuz/python-soxr> |
| starlette | 1.3.1 | BSD-3-Clause | <https://github.com/Kludex/starlette> |
| sympy | 1.14.0 | BSD-3-Clause | <https://github.com/sympy/sympy> |
| threadpoolctl | 3.6.0 | BSD-3-Clause | <https://github.com/joblib/threadpoolctl> |
| torch | 2.2.2+cu121 | BSD-3-Clause + NOTICE/third-party notices | <https://github.com/pytorch/pytorch> |
| torchaudio | 2.2.2+cu121 | BSD-2-Clause | <https://github.com/pytorch/audio> |
| tqdm | 4.69.1 | MPL-2.0 AND MIT | <https://github.com/tqdm/tqdm> |
| typer | 0.27.0 | MIT | <https://github.com/fastapi/typer> |
| typing-extensions | 4.16.0 | PSF-2.0 | <https://github.com/python/typing_extensions> |
| typing-inspection | 0.4.2 | MIT | <https://github.com/pydantic/typing-inspection> |
| urllib3 | 2.7.0 | MIT | <https://github.com/urllib3/urllib3> |
| uvicorn | 0.51.0 | BSD-3-Clause | <https://github.com/encode/uvicorn> |
| watchfiles | 1.2.0 | MIT | <https://github.com/samuelcolvin/watchfiles> |
| websockets | 16.1.1 | BSD-3-Clause | <https://github.com/python-websockets/websockets> |

License, COPYING, and NOTICE files supplied with each distribution take
precedence over the summary in this table.
