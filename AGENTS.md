# Repository Instructions

このファイルはリポジトリ全体に適用する。

## 最初に読む文書

1. `docs/SPECIFICATION.md`
2. `docs/DEVELOPMENT.md`
3. `README.md`

仕様書に記載された機能と開発ガイドの回帰条件を優先する。

## 変更してはいけない前提

- 推論はローカルモデルだけで実行する。オンライン推論APIへ接続しない。
- モデルを自動ダウンロードしない。
- 通常利用は`EarCopyAssist.exe`を直接起動するだけとし、利用者へ別サービスの
  手動起動を要求しない。
- MuScriptorのsmall／medium／largeを同じ仕組みで登録・利用可能にする。
- モデル重みをGitへ追加しない。`models/`と
  `*.safetensors`、`*.ckpt`、`*.pt`、`*.pth`、`*.onnx`、`*.th`、
  `*.gguf`は除外対象である。配布ビルド用SCNet Large重みも`models/`から読む。
- UIには操作に必要な説明だけを表示し、宣伝文や抽象的なキャッチコピーを追加しない。
- 既存のユーザー変更を破棄しない。

## 実装時の確認

- Python変更後は`uv run pytest -q`を実行する。
- Renderer／Electron変更後は`app`で`npm test -- --run`と
  `npm run typecheck`を実行する。
- 単体EXE作成とelectron-builderによるパッケージ化は一時停止中である。
  ユーザーから明示的な再開指示があるまで`npm run dist:win`を実行しない。
- `git diff --check`を通し、テストしていない内容を「確認済み」と記載しない。
- モデル混入は`git ls-files`と`git check-ignore -v <path>`で確認する。

## 重要な回帰条件

- Electron mainがランダムなloopbackポートで内蔵Pythonバックエンドを起動し、
  preload経由で接続情報をRendererへ渡す構成を維持する。
- Rendererからloopback以外のAPI URLを受け付けない。
- 原音Wave再生をSoundFontレンダリング経路へ戻さない。
- 入力Waveを44.1 kHz固定として扱わない。8／48／96 kHzの検証を維持する。
- ピアノロールの横軸、小節線、拍線、クオンタイズはBPMと拍位相に基づく。
- Soloが1件以上ある場合、再生だけでなくピアノロール表示もSoloパートだけにする。
- ドラムノートは短くても14 px以上の表示幅・選択領域を維持する。
- `NoteEnd <= NoteStart`は採譜全体の失敗にせず、最小10 msへ補正する。

## 公開

- EarCopy Assist本体は現在All rights reservedである。ライセンスを独断で
  OSSライセンスへ変更しない。
- バイナリ公開前に`docs/DISTRIBUTION.md`を読む。
- SCNet Large重みの再配布権と、GPLv3版FFmpegのComplete Corresponding Source
  提供方法が未解決の間は、現行EXEを公開可能と判断しない。
