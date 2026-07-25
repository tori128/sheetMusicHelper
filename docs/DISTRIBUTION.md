# 公開・配布チェックリスト

この文書は法的助言ではありません。公開者は、配布地域と配布方法に応じて
専門家へ確認してください。

## ソースリポジトリを公開する場合

1. `models/`、`UserData/`、`.ecaproj`、音源、生成EXEがコミット対象外であることを
   `git status --ignored`で確認する。
2. `LICENSE`、`THIRD_PARTY_NOTICES.md`、本書、ロックファイルを含める。
3. 公開対象コミットへタグを付け、テスト結果と既知の未実装項目をリリースノートへ
   記載する。
4. 現在のプロジェクト本体はAll rights reservedである。第三者へ改変・再配布を
   許可する場合は、権利者がMIT、Apache-2.0等を別途選択して`LICENSE`を更新する。

## Windows版を公開する場合

公開する配布物について、次の条件をすべて満たしていることを確認する。

### SCNet Largeモデル

SCNet Large重み`SCNet-large.th`を同梱する場合、重みの再配布条件を確認する。
SCNetリポジトリはMITだが、公式チェックポイントの配布ページに重み固有の
ライセンス表示がない。公開者は次のいずれかを行う。

- 権利者から重みの再配布許諾を確認し、その記録と条件を保存する。
- 重みを配布フォルダから除外し、利用者が正規配布元から別途取得する構成へ変更する。

### FFmpeg

同梱物は`gyan.dev`のFFmpeg 8.1.2 full static buildで、GPLv3である。

公開者は少なくとも次を行う。

1. `FFmpeg/LICENSE`と`FFmpeg/README.txt`を配布フォルダ内に保持する。
2. バイナリと同じ配布場所から、GPLv3が要求するComplete Corresponding Sourceを
   追加料金なしで取得できるようにする。
3. FFmpegコミット`38b88335f9`、ビルド設定、リンクされた外部ライブラリの
   対応ソースとビルド情報を保持する。
4. 配布ページにソース取得方法を明記し、提供期間を管理する。

単にFFmpeg上流コミットへリンクするだけで、静的full build全体の
Corresponding Source要件を満たすとは限らない。

### MuScriptorモデル

MuScriptorモデル重みは配布フォルダへ同梱しない。利用者が公式ページでCC BY-NC 4.0へ
同意して取得する。公開文書で次を明示する。

- モデルは非商用用途に制限される。
- EarCopy Assist本体の条件とモデルの条件は別である。
- アプリはモデルを自動ダウンロードしない。

### その他の同梱物

- MuseScore Generalの著作権表示とMIT本文を保持する。
- SpessaSynthのApache-2.0本文を保持する。
- PythonパッケージのLICENSE、COPYING、NOTICEを保持する。
- Electronの`LICENSE.electron.txt`と`LICENSES.chromium.html`を削除しない。
- `THIRD_PARTY_NOTICES.md`に記載したファイルのSHA-256を再計算し、一致を確認する。

## リリース検証

```powershell
uv sync --extra dev
uv run pytest

cd app
npm ci
npm test -- --run
npm run typecheck
npm run dist:win
npm run smoke:packaged
```

公開前に、クリーンなWindows環境へ配布フォルダ一式を配置して`EarCopyAssist.exe`を起動し、
モデル未登録時の案内、
モデル登録、採譜、4ステム分離、MIDI/MusicXML出力、ライセンス表示を確認する。

## 利用者が処理する音源

本アプリのライセンスは、利用者が入力する録音物、生成されるステム、
MIDI、MusicXMLについて権利を付与しない。利用者自身が必要な著作権・著作隣接権・
契約上の許可を確保する必要がある。
