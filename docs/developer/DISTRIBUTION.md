# 公開・配布チェックリスト

[English](DISTRIBUTION.en.md)

この文書は法的助言ではない。公開者は、配布地域と配布方法に応じて専門家へ確認する。

## ソースリポジトリを公開する場合

1. `git status --ignored`を実行し、`models/`、`UserData/`、`.ecaproj`、音源、
   生成した実行ファイルのGit追跡数が0であることを確認する。
2. `LICENSE`、日英のREADME・利用ガイド・第三者通知、本書、ロックファイルを含める。
3. 公開対象コミットへタグを付け、テスト結果、既知の不具合、利用上の制約をリリースノートへ
   記載する。
4. プロジェクト本体はMIT Licenseである。[`LICENSE`](../../LICENSE)、
   [README](../../README.md)、[利用ガイド](../USER_GUIDE.md)、それぞれの英語版、パッケージ情報、
   配布物内のライセンス表示を一致させる。

## Windows版を公開する場合

公開する配布物について、次の条件をすべて満たしていることを確認する。

### 音源分離モデル

推奨モデルはBS-RoFormer SW Fixedである。実装元の
Music-Source-Separation-TrainingリポジトリはMITだが、チェックポイントの配布ページには
重み固有の利用許諾条件の記載がなく、ライセンス表示は`Unknown`である。モデルが未配置の場合、
アプリはこの警告とファイル情報を表示し、利用者の確認後にHugging Faceから取得する。

- モデルページ:
  <https://huggingface.co/jarredou/BS-ROFO-SW-Fixed/tree/ad54168acf271482ad51702953e162a385b8fdcb>
- ファイルサイズ: `699412152` bytes
- SHA-256:
  `24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e`

公開前検査では、Windows本体パッケージ内のモデル重みがMuScriptor small、medium、largeの
3ファイルだけであることを確認する。

配布方針は次のとおりである。

- BS-RoFormer SW Fixed：Windows本体パッケージには同梱せず、アプリ内の警告確認後に取得する。
- MuScriptor small／medium／large：CC BY-NC 4.0が非商用目的の複製と共有を許諾するため、改変せず同じGitHub Releaseのモデルアーカイブとして配布する。

### LGPLコンポーネント

同梱物は公式ソースから`scripts/build_ffmpeg_lgpl.ps1`で作成する
FFmpeg 8.1.2の最小Windowsビルドである。GPLまたはnonfree機能と外部ライブラリを
無効にし、使用する音声形式とWave出力だけを有効にする。この構成のライセンスは
GNU LGPL version 2.1 or laterである。

- FFmpeg公式ソース:
  <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>
- ソースSHA-256:
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- ビルドスクリプト: `scripts/build_ffmpeg_lgpl.ps1`

Pythonバックエンドには、LGPL version 2.1 or laterのlibsndfile 1.2.2と
Python-SoXR 1.1.0も含まれる。

- libsndfile公式ソース:
  <https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz>
- libsndfileソースSHA-256:
  `3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e`
- libsndfileビルドスクリプト: `scripts/build_libsndfile_lgpl.ps1`
- Python-SoXR公式ソース:
  <https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz>
- Python-SoXRソースSHA-256:
  `9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44`

公開者は次を行う。

1. `FFmpeg/LICENSE`、`FFmpeg/COPYING.LGPLv3`、`FFmpeg/LICENSE.md`、
   `FFmpeg/README.txt`と、Pythonパッケージから収集したlibsndfile／SoXRの
   ライセンス文を配布フォルダ内に保持する。
2. 3コンポーネントの検証済み公式ソースとFFmpeg／libsndfileビルド手順を含む
   `EarCopyAssist-<version>-copyleft-sources.zip`を、
   Windowsバイナリと同じGitHub Releaseから取得可能にする。
3. バージョン、ソースSHA-256、ビルド設定が、`THIRD_PARTY_NOTICES.md`、
   `THIRD_PARTY_NOTICES.en.md`、対応ソースZIP内の`README.txt`で一致することを確認する。
4. FFmpegのconfigureオプションを`FFmpeg/README.txt`と照合する。構成を変更した場合は、
   変更後のライセンスと対応ソース提供条件を確認する。
5. GitHub Release本文にFFmpegの名称、GNU LGPL version 2.1 or later、
   対応ソースZIPのファイル名を表示する。

この方法では、利用したLGPLコンポーネントのソース一式をバイナリと並べて提供する。
配布時点の対応ソースをReleaseへ保存し、取得可能な状態を維持する。

### MuScriptorモデル

MuScriptor small、medium、largeのモデル重みを改変せずモデルアーカイブとして配布する。
利用者はWindows本体を展開した親フォルダーへ各モデルアーカイブを展開し、
`resources/models/muscriptor/<variant>/model.safetensors`へ配置する。公開文書と起動時の
確認画面には次の情報を記載する。

- モデルは非商用用途に制限される。
- EarCopy Assist本体の条件とモデルの条件は別である。
- 作成者はKyutaiおよびMireloである。
- CC BY-NC 4.0のURI、保証の否認、3モデルの取得元、改変していないことを記載する。
- 公式モデルページの入力する楽曲、生成物、法令遵守、無保証、補償に関する追加条件を記載する。
- 利用者が入力する楽曲に必要な権利または許諾を保有することを記載する。

### 依存パッケージの更新

本書と外部ソフトウェアの通知には、配布元の最新版ではなく、EarCopy Assistが
実際に使用するバージョンを記載する。

1. Pythonパッケージは`uv.lock`、JavaScriptパッケージは`app/package-lock.json`を更新する。
2. `THIRD_PARTY_NOTICES.md`と`THIRD_PARTY_NOTICES.en.md`のバージョン、
   ライセンス、取得元、必要な通知を更新する。
3. 配布物へ収録する`LICENSE`、`COPYING`、`NOTICE`ファイルを更新する。
4. 文書検査を実行し、ロックファイルと日英両文書の不一致がないことを確認する。

### その他の同梱物

- MuScriptorの`LICENSE`、`README.md`、`MODEL_NOTICE.txt`を保持し、コードの
  Copyright (c) 2026 Kyutai x Mirelo、公式Web UIを含む取得元、MITライセンス、
  モデル重みの作成者、CC BY-NC 4.0、3モデルの取得元、無改変、保証の否認を表示する。
- MuseScore Generalの`LICENSE.md`、`README.md`、`SAMPLE_SOURCES.csv`、
  `VERSION`、`SOURCE.md`を保持する。SoundFont本体のSHA-256が
  `5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3`
  と一致することを確認する。
- SpessaSynthのApache-2.0本文を保持する。
- PythonパッケージのLICENSE、COPYING、NOTICEを保持する。
- Electronの`LICENSE.electron.txt`と`LICENSES.chromium.html`を収録する。
- `THIRD_PARTY_NOTICES.md`と`THIRD_PARTY_NOTICES.en.md`に記載したファイルの
  SHA-256を再計算し、一致を確認する。

## リリース検証

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

`app/release-assets/`に次のファイルが生成される。Windows版パート数は圧縮後の
サイズによって増減する。

- `EarCopyAssist-<version>-win-x64.z01`
- `EarCopyAssist-<version>-win-x64.z02`以降（存在する場合）
- `EarCopyAssist-<version>-win-x64.zip`
- `EarCopyAssist-<version>-copyleft-sources.zip`
- `RELEASE_NOTES.md`
- `SHA256SUMS.txt`

各Release assetのサイズは2 GiB未満とする。Windows版の全分割ボリューム、最終ZIP、
LGPL対応ソースZIPを同じReleaseへ添付する。復元したWindows ZIPにMuScriptorの
3モデルと各`config.json`が存在し、BS-RoFormerを含む他のモデル重みが存在しないことを確認する。

`package:release`は追跡対象ファイルに未コミット変更がある場合は失敗する。
Windows ZIPの`BUILD_INFO.txt`とリリースノートには、ビルド元の40桁Gitコミットを
記録する。`verify:release`は標準分割ZIPのボリューム番号と再結合、各資産のSHA-256、
2 GiB制限、パス構造、必須ファイル、MuScriptorの3モデル、他のモデル重みと`UserData`の
非混入、対応ソース、ビルド元コミットを再検証する。

### Release公開

通常の`.github/workflows/ci.yml`は、モデル重みを使用しない単体テスト、型検査、
Renderer応答不能時の終了回帰を実行する。

#### GitHub Actionsによるパッケージ化

`.github/workflows/windows-release.yml`は手動実行だけを受け付け、GitHubの
`windows-release` environmentを使用する。Windows本体は標準GitHub-hosted Windows runnerで
作成する。公開前に、ローカルの検査済みMuScriptorモデルから
`scripts/prepare_muscriptor_release_sources.ps1`で一時アーカイブを作成し、対象タグの
非公開Releaseへ登録する。これらの一時アーカイブは最終公開前に削除される。

最初のジョブは、一時アーカイブをダウンロードして展開し、次の6ファイルのサイズ、SHA-256、
設定内容を検査する。検査に失敗した場合、Windows本体ビルドは開始しない。

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

モデル6ファイルの合計は7,105,675,208 bytesである。検査済みディレクトリはモデルごとに
GitHub Actions Cacheへ保存する。後続ジョブはこのキャッシュから1モデルずつ復元し、
GitHub Releaseの1ファイル2 GiB制限に対応した標準の分割ZIPを作成する。Windows本体パッケージには
モデル重みを含めない。

Node.js 24、Python 3.11、uv、MSYS2 MINGW64はワークフローが各GitHub Actionで設定する。
MSYS2の実際のインストール先は`EARCOPY_MSYS2_ROOT`としてFFmpegとlibsndfileのビルドへ渡す。

#### CIの起動手順

通常CIは`.github/workflows/ci.yml`で定義する。任意のブランチをGitHubへPushすると
自動起動し、Pythonテスト、Rendererテスト、型検査、Electron main processのコンパイル、
Renderer応答不能時の終了試験を実行する。

```powershell
git push origin <branch>
```

GitHub画面から手動実行する場合は、リポジトリの`Actions`から`CI`を選択し、
`Run workflow`で対象ブランチを指定する。GitHub CLIでは次を実行する。

```powershell
gh workflow run ci.yml --ref <branch>
```

Windows版パッケージ化CIは、`.github/workflows/windows-release.yml`が既定ブランチへ
Pushされた後に手動実行する。GitHub画面では、リポジトリの`Actions`から
`Windows Release`を選択し、`Run workflow`で対象ブランチと`release_tag`を指定する。
`release_tag`を空欄にした場合は、`app/package.json`のバージョンへ`v`を付けたタグを使用する。

GitHub CLIから既定のタグで起動する場合:

```powershell
gh workflow run windows-release.yml --ref master
```

タグを指定して起動する場合:

```powershell
gh workflow run windows-release.yml --ref master -f release_tag=v0.1.0
```

実行状況はGitHubの`Actions`画面、または次のコマンドで確認する。

```powershell
gh run list --workflow windows-release.yml
gh run watch <run-id> --exit-status
```

成功時は指定タグの公開Releaseを作成する。作成途中は非公開Releaseを使用し、同じタグの
非公開Releaseが存在する場合は、対象コミット、リリースノート、Release assetを更新する。

ワークフローはテスト、型検査、MuScriptorモデル検査、FFmpegとlibsndfileのビルド、
Electronパッケージ化、パッケージ起動試験、分割ZIP作成、Release asset検査を順に実行する。
成功時はWindows版の全`.zNN`ボリューム、最終`.zip`、対応ソースZIP、
`RELEASE_NOTES.md`、`SHA256SUMS.txt`を同じ公開Releaseへ登録する。既存の公開済みReleaseは
変更対象にしない。

ローカルで作成する場合は、MuScriptorの3モデルを`models/muscriptor/`へ配置したWindows
環境で前項のコマンドを実行し、生成されたRelease assetをReleaseへ登録する。

公開前に、クリーンなWindows環境へ配布フォルダ一式を配置して`EarCopyAssist.exe`を起動し、
起動時の利用条件確認、3モデルの登録、採譜、音源分離、MIDI/MusicXML出力、
ライセンス表示を確認する。

### クリーンWindows受入試験

クリーン環境の作成はホスト設定や費用へ影響する。実行環境、設定変更、費用を提示し、
公開責任者の承認後に次を実施する。

1. GitHub ReleaseからWindows版の全`.zNN`ボリューム、最終`.zip`、対応ソースZIP、
   `SHA256SUMS.txt`を取得し、
   すべてのSHA-256を照合する。
2. 全ボリュームを同じフォルダーに置き、7-Zipで最終`.zip`を開いて、1つの
   `EarCopyAssist-<version>-win-x64`フォルダーへ展開できることを確認する。
3. 起動し、MuScriptorの利用条件へ同意する前に内蔵サービスが起動しないこと、同意後に
   small、medium、largeの3モデルが表示されることを確認する。
4. 新規プロジェクト画面でBS-RoFormer SW Fixedのライセンス`Unknown`、配布ページ、
   699412152 bytes、保存先、SHA-256が表示されることを確認し、確認欄を選択して
   ダウンロードする。完了後に音源分離を選択できることを確認する。
5. 30秒の権利処理済み音源で直接採譜と音源分離後採譜を実行する。各工程で
   進捗、キャンセル、キャンセル後の編集、コード解析を確認する。
6. 再生モードを順に選択する。原音では採譜トラックがMute、採譜結果では原音・分離音源が
   Mute、左右比較では両側のMute／Soloがすべて解除されることを確認する。
7. 複数パートのSolo、採譜結果モードにおけるSolo対象採譜トラックの追加Mute、左右比較に
   おける採譜トラックと対応分離音源のMute／Solo連動を確認する。分離音源がないプロジェクト
   では、採譜トラックのMute／Solo操作後も原音全体が再生されることを確認する。
8. ノート編集、MIDI、MusicXML、分離WAV、`.ecaproj`保存／再読込を確認する。MIDIには
   画面上の音符位置、MusicXMLには書き出し画面で選択した音符の分解能が適用されることを
   確認する。
9. アプリを終了し、タスクマネージャーで`EarCopyAssist.exe`と
   `earcopy_service.exe`の実行数が0であることを確認する。
10. ライセンス画面と`licenses/`、対応ソースZIPの内容を確認する。

### コード署名

現行0.1.0のAuthenticode状態は`NotSigned`である。署名証明書の取得は費用と本人確認を
伴うため、購入・申請には公開責任者の承認を必要とする。署名前後の状態は次で確認できる。

```powershell
.\scripts\check_authenticode.ps1
.\scripts\check_authenticode.ps1 -RequireValid
```

署名する場合は、少なくとも配布本体の`EarCopyAssist.exe`と内蔵`earcopy_service.exe`を
同一公開者証明書で署名し、
タイムスタンプを付与する。署名後にパッケージを再生成し、ハッシュとスモークテストを
やり直す。

## 利用者が処理する音源

利用者は、入力する録音物、生成されるステム、MIDI、MusicXMLについて、必要な著作権、
著作隣接権者および収録音源の権利者から許諾を得る。
