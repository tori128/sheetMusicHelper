# EarCopy Assist ${VERSION}

EarCopy AssistのWindows x64用ポータブルパッケージです。自己解凍ZIPの`.exe`を実行して展開し、
`EarCopyAssist.exe`を起動してください。

ソースコミット: [${SOURCE_COMMIT}](https://github.com/tori128/sheetMusicHelper/tree/${SOURCE_COMMIT})

## 変更内容

- 未保存の編集がある場合、ウィンドウを閉じる前に確認します。
- MIDI出力で画面上の音符の開始位置と終了位置を保持します。
- ユーザープリセットの上書きと、採譜開始直後のキャンセルを修正しました。
- テンポ推定で初期推定の1.5倍・2倍の候補を比較し、検証音源の150、164、172、173 BPMを判定できるようにしました。
- 再生モード変更時の再生開始処理、MusicXML書き出しの音符分解能、日本語ファイル名の処理を修正しました。
- Windows本体とMuScriptorモデルを自己解凍ZIPで配布します。
- 日本語・英語のREADMEと利用ガイドを更新しました。

## 利用条件と対応ソース

EarCopy Assist本体はMIT Licenseです。MuScriptorモデルはCC BY-NC 4.0と配布元の追加条件に従い、非商用用途に制限されます。BS-RoFormer SW Fixedの利用条件はアプリ内の取得画面で確認できます。

FFmpeg 8.1.2はGNU LGPL version 2.1 or laterです。FFmpeg、libsndfile、Python-SoXRの対応ソースは、同じReleaseの`EarCopyAssist-${VERSION}-copyleft-sources.zip`から取得できます。各配布ファイルのSHA-256は`SHA256SUMS.txt`に記載します。

## 検証と制約

ローカル環境でPythonテスト335件、UIテスト379件、型検査を実行しました。Renderer応答不能時の終了試験は1,070 msで成功しました。配布パッケージは公開処理で起動試験とファイル検査を実行します。

テンポ推定の変更後の公開データセット評価は未実施です。推定BPMと小節先頭位置は編集画面で確認・変更できます。

## ダウンロード

- `EarCopyAssist-${VERSION}-win-x64.zxx`: Windows版自己解凍ZIPの前方ボリューム
- `EarCopyAssist-${VERSION}-win-x64.exe`: Windows版自己解凍ZIP
- `EarCopyAssist-${VERSION}-muscriptor-small.exe`: MuScriptor smallモデルの自己解凍ZIP
- `EarCopyAssist-${VERSION}-muscriptor-medium.exe`: MuScriptor mediumモデルの自己解凍ZIP
- `EarCopyAssist-${VERSION}-muscriptor-large.z01`以降: MuScriptor largeモデル自己解凍ZIPの前方ボリューム
- `EarCopyAssist-${VERSION}-muscriptor-large.exe`: MuScriptor largeモデルの自己解凍ZIP

`.z01`から始まる全ボリュームと対応する`.exe`を同じフォルダーへ置き、`.exe`を実行して展開先フォルダーを選択してください。

## 使用前の準備

モデルの取得・配置手順は展開後の`README.md`、操作方法は`docs/USER_GUIDE.md`を参照してください。
英語版の操作方法は`docs/USER_GUIDE.en.md`にあります。
