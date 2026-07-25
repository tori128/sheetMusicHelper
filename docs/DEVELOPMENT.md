# 開発ガイド

この文書は、EarCopy Assistの開発環境、構成、実装状況、検証方法をまとめたものです。
機能とデータ形式の詳細は[機能・技術仕様](SPECIFICATION.md)を参照してください。

## 開発環境

- Windows 10またはWindows 11 64-bit
- Python 3.11
- [uv](https://docs.astral.sh/uv/)
- Node.jsとnpm
- Git
- CUDA利用時は対応するNVIDIA GPUとドライバー

```powershell
uv sync --extra dev

cd app
npm ci
```

MuScriptorモデルとSCNet Largeモデルはリポジトリに含まれません。正規配布元から
取得したファイルを次の構成で配置します。

```text
models/
├─ muscriptor/
│  ├─ small/
│  │  ├─ model.safetensors
│  │  └─ config.json
│  ├─ medium/
│  │  ├─ model.safetensors
│  │  └─ config.json
│  └─ large/
│     ├─ model.safetensors
│     └─ config.json
└─ scnet/
   └─ large/
      ├─ SCNet-large.th
      └─ config.yaml
```

## リポジトリ構成

| Path | 役割 |
|---|---|
| `src/earcopy_service/` | FastAPIベースのローカルサービス |
| `src/earcopy_service/backends/` | MuScriptor CPU／CUDA推論 |
| `src/earcopy_service/stem_separation.py` | SCNet Large CPU／CUDA 4ステム分離 |
| `src/earcopy_service/tempo_estimation.py` | BPM・拍位相解析 |
| `src/earcopy_service/midi_export.py` | Standard MIDI File出力 |
| `src/earcopy_service/musicxml_export.py` | MusicXML 4.0出力 |
| `app/src/` | React UI、編集ストア、Canvas描画、再生 |
| `app/electron/` | Electron main、preload、ローカルサービス管理 |
| `app/packaging/` | Windows配布設定 |
| `tests/` | Python単体・API・統合テスト |
| `scripts/` | 実モデルと配布物の検証スクリプト |

## 実行構成

Electron mainは空いているloopbackポートとセッショントークンを生成し、Python
ローカルサービスを子プロセスとして起動します。Rendererはpreload経由で接続情報を
受け取ります。採譜要求には登録済みローカルモデルのパスを渡します。

推論バックエンドは`Auto`、`CPU`、`CUDA`です。`Auto`はCUDAを優先し、利用できない
環境ではCPUを使用します。CUDA版PyTorchはCPU実行も含むため、同一環境で両方の
バックエンドを検証できます。

## 実装状況

| 領域 | 状況 |
|---|---|
| MuScriptor | small／medium／large登録、CPU／CUDA推論、楽器制約 |
| 音源 | FFmpeg変換、解析WAVキャッシュ、BPM・拍位相解析 |
| 音源分離 | SCNet Largeによるdrums／bass／vocals／other CPU／CUDA分離 |
| 編集 | 統合ピアノロール、ドラムロール、選択、移動、クオンタイズ |
| 再生 | 原音／SoundFont切替、シーク、Mute／Solo、出力デバイス選択 |
| 保存 | `.ecaproj`保存・読込 |
| 出力 | MIDI Format 1、MusicXML 4.0、4ステムWAV |
| デスクトップ | Electron UI、内蔵ローカルサービス、ライセンス表示 |

CUDAはRTX 3060上のMuScriptor small推論とSCNet Large分離、配布用バックエンド
中間成果物での能力検出まで確認しています。ポインタ操作のE2E試験、MuseScore本体でのMusicXML
読込、任意の実オーディオデバイスでの出音は追加検証の対象です。

## 検証

Pythonを変更した場合:

```powershell
uv run pytest -q
```

RendererまたはElectronを変更した場合:

```powershell
cd app
npm test -- --run
npm run typecheck
```

実モデルによるCUDA推論:

```powershell
uv run python scripts/smoke_transcribe.py `
  --backend CUDA `
  --dtype float16 `
  --model models/muscriptor/small/model.safetensors `
  --audio path/to/audio.wav
```

SCNet Largeによる実分離:

```powershell
uv run python scripts/smoke_stem_separation.py `
  --model-dir models/scnet/large
```

配布バックエンドの受入試験:

```powershell
uv run python scripts/acceptance_packaged_backend.py `
  --backend app/release/win-unpacked/resources/backend/earcopy_service.exe `
  --model models/muscriptor/small/model.safetensors `
  --tempo-fixture "172=tests/bpm172.wav" `
  --tempo-fixture "173=tests/bpm173.wav"
```

最後に`git diff --check`を実行し、モデル重みがGit管理対象外であることを確認します。

```powershell
git diff --check
git ls-files models
git check-ignore -v models/muscriptor/small/model.safetensors
git check-ignore -v models/scnet/large/SCNet-large.th
```

## 回帰条件

- Electron mainがloopback上でローカルサービスを起動する構成を維持する。
- 原音再生をSoundFontレンダリング経路へ接続しない。
- 入力Waveを44.1 kHz固定として扱わない。
- 小節線、拍線、クオンタイズはBPMと拍位相に基づいて計算する。
- Soloがある場合、再生とピアノロール表示の両方をSoloパートに限定する。
- ドラムノートの表示幅と選択領域は14 px以上を維持する。
- 終了時刻が開始時刻以下のノートは最小10 msへ補正する。
