# EarCopy Assist

EarCopy Assistは、音源から楽器ごとの演奏ノートを採譜し、ピアノロールで修正して
MIDIまたはMusicXMLへ書き出すWindowsデスクトップアプリケーションです。音源解析と
モデル推論はPC内で実行されます。

## 主な機能

- MuScriptor `small`、`medium`、`large`モデルによるCPU／CUDA採譜
- 直接採譜とSCNet Largeによる4ステム分離後採譜
- 音程パートの統合ピアノロールとGMドラムロール
- BPM、拍位相、拍子に基づく小節線、拍線、クオンタイズ
- ノート選択、パート移動、全体位置補正
- 原音とSoundFontによる採譜結果の切替再生
- Mute、Solo、再生位置追従、Windows出力デバイス選択
- `.ecaproj`形式によるプロジェクト保存と再読込
- Standard MIDI File Format 1、MusicXML 4.0、4ステムWAV出力

## 必要なもの

- Windows 10またはWindows 11 64-bit
- MuScriptorモデルの`model.safetensors`と`config.json`
- CUDA利用時は対応するNVIDIA GPUとドライバー
- 配布物にSCNet Largeが含まれない場合は`SCNet-large.th`と`config.yaml`

モデルファイルは各モデルの正規配布元から取得してください。MuScriptor公式モデルは
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)で提供され、
非商用用途に制限されます。

## 利用方法

1. `EarCopyAssist.exe`を起動します。
2. MuScriptorモデルを登録します。
3. 音源、編成プリセット、処理モード、推論バックエンド、拍子を選択します。
4. 採譜を実行し、ピアノロールでノートを修正します。
5. プロジェクト、MIDI、MusicXML、または分離WAVを保存します。分離WAVの保存後は、
   保存先がエクスプローラーで開きます。

EXEと同じ場所にモデルを配置する場合は、次のフォルダー構成にします。

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

推論バックエンドの`Auto`はCUDAを優先し、対応するGPUがない環境ではCPUを使用します。

## ドキュメント

- [ドキュメント一覧](docs/README.md)
- [機能・技術仕様](docs/SPECIFICATION.md)
- [開発ガイド](docs/DEVELOPMENT.md)
- [公開・配布チェックリスト](docs/DISTRIBUTION.md)
- [第三者コンポーネント通知](THIRD_PARTY_NOTICES.md)

## ライセンス

EarCopy Assist本体の原著作物は現在All rights reservedです。詳細は
[LICENSE](LICENSE)を参照してください。第三者コンポーネントには、それぞれの
ライセンス条件が適用されます。
