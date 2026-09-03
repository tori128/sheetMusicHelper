# 外部ソフトウェアとモデルの利用条件・取得元

[English](THIRD_PARTY_NOTICES.en.md)

EarCopy Assistは外部のソフトウェアとデータを利用し、その一部を配布パッケージに同梱します。
EarCopy Assist本体のライセンスは、ここに記載する個別のライセンスを置き換えたり、制限したりするものではありません。

本書にはEarCopy Assistが実際に使用するバージョンを記載し、依存関係を更新するときに記載内容も更新します。

## 別途取得するモデル

BS-RoFormer SW Fixedの重みはWindows本体パッケージに同梱されません。未配置の場合、
アプリは配布ページのライセンス表示が`Unknown`であることを表示し、利用者の確認後に
Hugging Faceから取得します。`Unknown`は利用許諾を意味しません。

## MuScriptor

### コード

- 対象：MuScriptor 0.2.2 Pythonパッケージおよび公式Web UI
- 利用箇所：モデルの読み込みと音符イベント生成
- 初期版で参照した範囲：音符イベント表示、ピアノロール、原音・SoundFont同期再生の設計
- 著作権表示：Copyright (c) 2026 Kyutai x Mirelo
- 取得元：<https://github.com/muscriptor/muscriptor>
- ライセンス：MIT
- 同梱するライセンス本文：`app/resources/licenses/MuScriptor/LICENSE`

### モデル重み

EarCopy AssistのGitHub Releaseは、公式の`small`、`medium`、`large`モデル重みを改変せずモデルアーカイブとして配布します。
モデル重みには[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)が適用され、利用と再配布は非商用目的に制限されます。
作成者はKyutaiおよびMireloです。各モデルの公式ページには、入力する音楽と生成物、法令遵守、無保証、補償に関する追加条件も掲載されています。
入力する楽曲について、著作権その他の必要な権利または許諾を保有する必要があります。
保証の否認はCC BY-NC 4.0第5条、同梱する表示は`app/resources/licenses/MuScriptor/MODEL_NOTICE.txt`を参照してください。

- <https://huggingface.co/MuScriptor/muscriptor-small>
- <https://huggingface.co/MuScriptor/muscriptor-medium>
- <https://huggingface.co/MuScriptor/muscriptor-large>
- 改変の有無：改変なし
- small SHA-256：`bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c`
- medium SHA-256：`ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec`
- large SHA-256：`ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397`

## BS-RoFormer

- 対象：BS-RoFormer SW Fixedの推論コードとモデル
- コードの著作権表示：Copyright (c) 2024 Roman Solovyev (ZFTurbo)
- コードの取得元：<https://github.com/ZFTurbo/Music-Source-Separation-Training>
- コードのライセンス：MIT
- モデル重み：`BS-Rofo-SW-Fixed.ckpt`
- 学習者：配布ページに記載なし
- 配布ページの登録者：jarredou
- アプリが参照する配布ページ：<https://huggingface.co/jarredou/BS-ROFO-SW-Fixed/tree/ad54168acf271482ad51702953e162a385b8fdcb>
- モデル重みのライセンス表示：`Unknown`
- モデル重みのファイルサイズ：`699412152` bytes
- モデル重みのSHA-256：`24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e`

## MuseScore General SoundFont

- 対象：`MuseScore_General.sf3`
- バージョン：0.2.0
- 配布元：<https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/>
- ライセンス：MIT
- SHA-256：`5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3`

次の著作権表示が必要です。

- FluidR3：Copyright (c) 2000-2002, 2008 Frank Wen
- FluidR3Mono conversion：Copyright (c) 2014-2017 Michael Cowgill
- MuseScore General adaptation：Copyright (c) 2018-2019 S. Christian Collins
- Temple Blocks：Copyright (c) 2002 Ethan Winer
- Drumline Cymbals：Copyright (c) 2016 Michael Schorsch

配布元の通知全文とMIT Licenseの本文は、`MuseScore_General/LICENSE.md`として同梱します。

## FFmpegとFFprobe

- 対象：FFmpeg 8.1.2の最小構成によるWindows向け静的コマンドラインビルド
- 配布形態：公式ソースコードから本プロジェクトでビルドした実行ファイルを配布パッケージに同梱
- ソースコード：<https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>
- ソースコードのSHA-256：`464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- この構成に適用されるライセンス：GNU Lesser General Public License version 2.1 or later
- 再現用ビルドスクリプト：`scripts/build_ffmpeg_lgpl.ps1`
- ビルド設定：同梱する`FFmpeg/README.txt`

EarCopy Assistは、`ffmpeg.exe`と`ffprobe.exe`を別プログラムとして起動します。
両方の実行ファイルは置き換え可能です。
ビルド時には、GPL、nonfree、自動検出、外部ライブラリの各機能を無効にしています。
LGPLのライセンス本文、配布元のライセンス概要、使用したconfigureオプションはアプリと一緒に配布します。

## libsndfile

- 対象：libsndfile 1.2.2
- 利用元：python-soundfile 0.14.0
- 配布形態：公式ソースコードから本プロジェクトでビルドしたDLLを配布パッケージに同梱
- バイナリ：`_soundfile_data/libsndfile_x64.dll`
- ソースコード：<https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz>
- ソースコードのSHA-256：`3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e`
- ライセンス：GNU Lesser General Public License version 2.1 or later
- 再現用ビルドスクリプト：`scripts/build_libsndfile_lgpl.ps1`

EarCopy Assistは正規化したWAVファイルだけをlibsndfileへ渡すため、このDLLでは外部コーデックライブラリとMPEG対応を無効にしています。
生成したDLLはWindowsのシステムライブラリだけに依存し、同じインターフェースを持つ変更版へ置き換えられます。

## Python-SoXRとlibsoxr

- 対象：Python-SoXR 1.1.0と同梱の変更版libsoxr
- 配布形態：PyPI公式Windows wheelのビルド済み拡張モジュールを配布パッケージに同梱
- バイナリ：`soxr/soxr_ext.cp311-win_amd64.pyd`
- Windows wheel：<https://files.pythonhosted.org/packages/8f/29/371467eb86c7ba6810df0bfe9409bcd9c52ec5615b111190fafe23e4d2e1/soxr-1.1.0-cp311-cp311-win_amd64.whl>
- Windows wheelのSHA-256：`ae30c48ac795378cf23ba3c7c640b8ff794af714ac388b9fd6b31a40b39e6e86`
- 対応ソースコード：<https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz>
- ソースコードのSHA-256：`9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44`
- ライセンス：GNU Lesser General Public License version 2.1 or later

## 対応ソースの配布

`EarCopyAssist-<version>-copyleft-sources.zip`には、FFmpeg、libsndfile、Python-SoXRの検証済みソースアーカイブと、このプロジェクトが使用したFFmpegおよびlibsndfileのビルドスクリプトを収録します。
このZIPを配布ZIPと同じGitHub Releaseで公開します。
ZIP内の`README.txt`には、対応する各バイナリ、ソースURL、SHA-256、ビルド情報を記載します。

## 同梱するライセンス文書

Electronの`LICENSE.electron.txt`と`LICENSES.chromium.html`を配布パッケージに収録します。

パッケージ作成時に、実行時に使用するPythonパッケージから`LICENSE`、`COPYING`、`NOTICE`ファイルを収集し、アプリのライセンス画面に表示します。
一部のパッケージには、同梱するネイティブライブラリについて追加の通知が含まれています。
各パッケージに付属するライセンス本文および通知が、本書の記載より優先されます。

## 実行時依存関係一覧

次の一覧は、アプリの実行時に使用するパッケージを示します。

### JavaScriptおよびデスクトップ実行時パッケージ

| パッケージ | バージョン | ライセンス | ソースコード |
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

### Python実行時パッケージ

| パッケージ | バージョン | ライセンス | ソースコード |
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

各パッケージに付属する`LICENSE`、`COPYING`、`NOTICE`ファイルが、この表の概要より優先されます。
