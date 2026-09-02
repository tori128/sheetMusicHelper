# EarCopy Assist ${VERSION}

EarCopy AssistのWindows x64用ポータブルパッケージです。ZIPを展開し、
`EarCopyAssist.exe`を起動してください。

ソースコミット: [`${SOURCE_COMMIT}`](https://github.com/tori128/sheetMusicHelper/tree/${SOURCE_COMMIT})

## ダウンロード

- `EarCopyAssist-${VERSION}-win-x64.z01`: Windows版分割ZIPの先頭ボリューム
- `EarCopyAssist-${VERSION}-win-x64.z02`以降: 存在する場合は残りの全ボリューム
- `EarCopyAssist-${VERSION}-win-x64.zip`: Windows版分割ZIPの最終ボリューム
- `EarCopyAssist-${VERSION}-copyleft-sources.zip`: LGPLコンポーネントの対応ソース
- `SHA256SUMS.txt`: リリース資産のSHA-256

`.z01`から始まる全ボリュームと最後の`.zip`を同じフォルダーへ置き、
[7-Zip](https://www.7-zip.org/)などの分割ZIP対応ソフトで、最後の`.zip`を開いて
展開してください。この分割により、各ファイルを
GitHub Releaseの1ファイル2 GiB制限内に収めています。

ダウンロード後は`SHA256SUMS.txt`でファイルを検証してください。

## 使用前の準備

MuScriptor small、medium、largeのモデル重みは改変せず同梱しています。
EarCopyAssist.exeの起動時にCC BY-NC 4.0と追加条件を確認してください。
BS-RoFormer SW Fixedが未配置の場合は、新規プロジェクト画面でライセンス`Unknown`、
配布ページ、699,412,152 bytes、SHA-256を確認してダウンロードします。
MuScriptor公式モデルはCC BY-NC 4.0と追加条件の対象です。非商用用途の制限と、
入力音源・生成物に必要な権利を確認してください。

モデルの取得・配置手順は展開後の`README.txt`、操作方法は
`docs/USER_GUIDE.md`を参照してください。英語版の操作方法は
`docs/USER_GUIDE.en.md`にあります。

## 主な機能

- MuScriptor small／medium／largeによるCPU・CUDA採譜
- BS-RoFormer SW Fixedで6成分へ分離し、成分ごとに採譜して統合
- ピアノロールでのノート位置・音高・長さの編集、Undo／Redo、テンポ・拍位置・クオンタイズ編集
- BPM・拍位置・小節先頭の推定、2拍単位のコード推定
- 原音／採譜結果再生、左右チャンネル比較、モード別のMute／Solo、メトロノーム
- 日本語、英語、中国語の表示
- `.ecaproj`、MIDI Format 1、MusicXML 4.0、分離WAV出力

## 注意事項

- 配布実行ファイルのAuthenticode状態は`NotSigned`です。
- 自動採譜、テンポ推定、コード推定、MusicXML変換の結果は、ピアノロールと出力先ソフトで
  確認してください。
- EarCopy Assist本体とモデル、入力音源、生成物にはそれぞれ別の権利条件が適用されます。
- FFmpeg、libsndfile、Python-SoXRに対応するソースは
  `EarCopyAssist-${VERSION}-copyleft-sources.zip`に収録しています。

## FFmpeg

このソフトウェアは[FFmpeg](https://ffmpeg.org/)を使用しています。同梱する
FFmpeg 8.1.2最小ビルドはGNU LGPL version 2.1 or laterの条件で提供されます。
対応する公式ソース、ビルドスクリプト、ビルド設定は
`EarCopyAssist-${VERSION}-copyleft-sources.zip`に収録し、配布ZIPと同じ
GitHub Releaseから提供します。

---

# EarCopy Assist ${VERSION} (English)

This is the portable Windows x64 package. Extract the ZIP and launch
`EarCopyAssist.exe`.

Source commit: [`${SOURCE_COMMIT}`](https://github.com/tori128/sheetMusicHelper/tree/${SOURCE_COMMIT})

## Download

- `EarCopyAssist-${VERSION}-win-x64.z01`: First volume of the split Windows ZIP
- `EarCopyAssist-${VERSION}-win-x64.z02` and later: Every remaining volume, when present
- `EarCopyAssist-${VERSION}-win-x64.zip`: Final volume of the split Windows ZIP
- `EarCopyAssist-${VERSION}-copyleft-sources.zip`: Corresponding source for LGPL components
- `SHA256SUMS.txt`: SHA-256 checksums for release assets

Put every `.zNN` volume and the final `.zip` in one folder, then open the final
`.zip` with [7-Zip](https://www.7-zip.org/) or another split-ZIP-compatible
archiver. The split keeps each asset below GitHub's 2 GiB limit.

Verify downloaded files against `SHA256SUMS.txt`.

## Setup

MuScriptor small, medium, and large are included without modification. Review
CC BY-NC 4.0 and the additional conditions when EarCopyAssist.exe starts.
When BS-RoFormer SW Fixed is absent, review its `Unknown` license status,
distribution page, 699,412,152-byte size, and SHA-256 on the new-project
screen, then download it.
Official MuScriptor models are subject to CC BY-NC 4.0 and additional terms,
including a non-commercial-use restriction. Confirm the rights needed for the
input audio and generated content.

See `README.txt` in the extracted package for model setup and
`docs/USER_GUIDE.en.md` for operation instructions.

## Main features

- CPU and CUDA transcription with MuScriptor small, medium, or large
- BS-RoFormer SW Fixed separation into six components followed by per-component transcription
- Piano-roll note timing, pitch, and length editing, Undo and Redo, tempo, beat-position, and
  quantization controls
- BPM, beat-position, and downbeat estimation, and chord estimation in two-beat intervals
- Source and transcription playback, L/R channel comparison, mode-specific Mute and Solo, and metronome
- Japanese, English, and Chinese display languages
- `.ecaproj`, MIDI Format 1, MusicXML 4.0, and separated WAV export

## Notes

- The distributed executable has an Authenticode status of `NotSigned`.
- Review automatic transcription, tempo estimation, chord estimation, and MusicXML conversion in the
  piano roll and destination application.
- EarCopy Assist, models, source audio, and generated output have separate rights and license terms.
- Corresponding source for FFmpeg, libsndfile, and Python-SoXR is included in
  `EarCopyAssist-${VERSION}-copyleft-sources.zip`.

## FFmpeg

This software uses [FFmpeg](https://ffmpeg.org/). The bundled minimal FFmpeg
8.1.2 build is provided under GNU LGPL version 2.1 or later. The official source,
build scripts, and build configuration are in
`EarCopyAssist-${VERSION}-copyleft-sources.zip`, published on the same GitHub Release.
