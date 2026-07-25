# Third-Party Notices

EarCopy Assist uses and, in its Windows portable build, redistributes
third-party software and assets. The EarCopy Assist project license does not
replace or restrict the licenses listed here.

Exact package versions are fixed by [`uv.lock`](uv.lock) and
[`app/package-lock.json`](app/package-lock.json). A runtime dependency inventory
is included below.

## MuScriptor

- Component: MuScriptor Python package 0.2.2
- Copyright holders: MuScriptor contributors; developed by Kyutai and Mirelo
- Source: <https://github.com/muscriptor/muscriptor>
- Code license: MIT

MuScriptor model weights are not stored in this repository and are not bundled
in the portable EXE. Users obtain and register them separately. The official
`small`, `medium`, and `large` weights are licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) and are
restricted to non-commercial use:
<https://huggingface.co/MuScriptor>.

## SCNet

- Component: SCNet Large
- Copyright: Copyright (c) 2024 starrytong
- Source: <https://github.com/starrytong/SCNet>
- Code license: MIT
- Bundled weight: `SCNet-large.th`
- Upstream file: <https://drive.google.com/file/d/1s7QvQwn8ag9oVstGDBQ6KZvacJkvyK7t/view>
- Weight SHA-256:
  `719e5abb8ed920305dad546ac3cd6fb0b1e9c3092d14ce21827bfc0423af3070`
- Configuration SHA-256:
  `629a4901184bf1d3a75b0b13904f35974785aa042cad3c010fd576248cdce3f0`

The upstream repository is MIT-licensed and publishes SCNet Large as an
official pretrained checkpoint. It does not state
separate model-weight terms next to the downloaded file. Because the
model-specific redistribution grant is not explicit, distributors should
obtain confirmation from the upstream rights holder or omit the weight from
public binary releases. This repository does not grant rights to that weight.

## MuseScore General SoundFont

- Component: `MuseScore_General.sf3`
- Version: 0.2
- Upstream: <https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/>
- Mirror used by MuScriptor: <https://huggingface.co/MuScriptor/assets>
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

- Component: FFmpeg 8.1.2 full static Windows build
- Binary distributor: <https://www.gyan.dev/ffmpeg/builds/>
- Upstream source: <https://github.com/FFmpeg/FFmpeg/commit/38b88335f9>
- License for this configured build: GNU GPL version 3
- Build configuration and external-library list: the bundled
  `FFmpeg/README.txt`

EarCopy Assist invokes `ffmpeg.exe` and `ffprobe.exe` as separate programs.
The GPLv3 license text and the build README are distributed with the EXE.
A distributor of the portable EXE must also provide recipients with the
Complete Corresponding Source in a GPLv3-compliant manner. A link in this
notice alone must not be assumed to satisfy every distribution method. See
[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

## SpessaSynth

- Components: `spessasynth_core` 4.3.15 and `spessasynth_lib` 4.3.11
- Sources:
  - <https://github.com/spessasus/spessasynth_core>
  - <https://github.com/spessasus/spessasynth_lib>
- License: Apache License 2.0

The Apache-2.0 license texts from both npm packages are distributed with the
portable application.

## Electron, Chromium, React, and JavaScript runtime packages

- Electron 43.2.0: MIT, <https://github.com/electron/electron>
- Chromium and its bundled components: individual licenses collected in
  Electron's generated `LICENSES.chromium.html`
- React 19.2.8: MIT, <https://github.com/facebook/react>
- React DOM 19.2.8: MIT, <https://github.com/facebook/react>
- Scheduler 0.27.0: MIT, <https://github.com/facebook/react>

Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` are emitted by
Electron Builder next to the unpacked application and remain part of the
portable package.

## Python and Python runtime packages

- CPython 3.11: Python Software Foundation License

The packaging process collects available `LICENSE`, `COPYING`, and `NOTICE`
files from runtime Python distributions and exposes them in the application's
license viewer. Some packages include additional notices for bundled native
libraries; those supplied texts remain controlling.

## Runtime dependency inventory

Build and test tools such as Vite, TypeScript, Vitest, Testing Library,
Electron Builder, PyInstaller, and pytest are recorded in the lock files but
are not listed as application runtime dependencies here.

### JavaScript and desktop runtime

| Package | Version | License | Source |
|---|---:|---|---|
| Electron | 43.2.0 | MIT | <https://github.com/electron/electron> |
| React | 19.2.8 | MIT | <https://github.com/facebook/react> |
| React DOM | 19.2.8 | MIT | <https://github.com/facebook/react> |
| scheduler | 0.27.0 | MIT | <https://github.com/facebook/react> |
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

## No endorsement

MuScriptor, Kyutai, Mirelo, SCNet, MuseScore, SpessaSynth, FFmpeg, Electron,
React, Python, and other names are used only to identify upstream components.
Their inclusion does not imply endorsement of EarCopy Assist.
