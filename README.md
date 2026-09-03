# EarCopy Assist

[English Version](README.en.md)

![main](docs\assets\main.png)

EarCopy Assistは、音源から楽器ごとの演奏情報を採譜し、結果の確認、修正、保存、書き出しを行うWindowsアプリケーションです。  
音源分離と組み合わせて採譜精度を向上させることを特徴としています。



## 必要なもの
- Windows 10またはWindows 11 64ビット版
- 音源分離してから採譜する場合はBS-RoFormer SW Fixed
- CUDAを使用する場合は対応するNVIDIA GPUとドライバ  
※ NVIDIA GPUを使用できない環境ではCPU処理で採譜できます



## 機能
- **採譜**：原音を直接採譜する方法と、音源分離してから採譜する方法を選べます。
- **楽器の指定**：編成プリセットで出力トラックの候補を指定する方法と、楽器を自動推定する方法を選べます。
- **確認と修正**：音符の試聴、追加、範囲削除、移動、長さ変更、別パートへの移動、Undo／Redoができます。
- **拍に沿った編集**：推定テンポと拍子に基づく小節・拍表示、クオンタイズ、拍位置の設定ができます。
- **コード名の表示**：採譜結果からコードを推定します。
- **原音との差を表示**：原音との不一致度を1拍単位で色分け表示します。
- **再生による確認**：原音と採譜結果の切替、左右チャンネルでの同時比較、Mute、Solo、メトロノームを利用できます。
- **表示言語**：日本語、英語、中国語から選択できます。
- **保存と書き出し**：`*.ecaproj`（独自形式）、MIDI、MusicXML、分離WAVを保存できます。



## 関連文書
- [使い方](docs/USER_GUIDE.md) / [How to use](docs/USER_GUIDE.en.md)
- [性能評価](docs/TRANSCRIPTION_METHOD_BENCHMARK.md) / [Public transcription benchmark](docs/TRANSCRIPTION_METHOD_BENCHMARK.en.md)
- [テンポ・拍・小節先頭推定の公開評価](docs/developer/TEMPO_DOWNBEAT_EVALUATION.md) / [Public tempo, beat, and downbeat evaluation](docs/developer/TEMPO_DOWNBEAT_EVALUATION.en.md)
- [開発ガイド](docs/developer/DEVELOPMENT.md) / [Development guide](docs/developer/DEVELOPMENT.en.md)
- [公開・配布チェックリスト](docs/developer/DISTRIBUTION.md) / [Release and distribution checklist](docs/developer/DISTRIBUTION.en.md)



## ライセンス
EarCopy Assist本体は[MIT License](LICENSE)で提供します。  
外部ソフトウェア、再生用音源、AIモデルには、それぞれのライセンスと利用条件が適用されます。  
MuScriptor公式モデルは[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)と各配布ページの追加条件により、非商用用途に制限されます。  
詳細は[外部ソフトウェアとモデルの利用条件・取得元](THIRD_PARTY_NOTICES.md)を参照してください。
