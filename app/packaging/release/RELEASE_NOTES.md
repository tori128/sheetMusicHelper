# EarCopy Assist ${VERSION}

EarCopy AssistのWindows x64用ポータブルパッケージです。自己解凍ZIPの`.exe`を実行して展開し、
`EarCopyAssist.exe`を起動してください。

ソースコミット: [${SOURCE_COMMIT}](https://github.com/tori128/sheetMusicHelper/tree/${SOURCE_COMMIT})

## 変更内容

- 分離音源のSolo操作や再生切り替えで、PCM読み込みがキャンセルされて再生エラーになる不具合を修正しました。
- MusicXML書き出しで、隣接する音符の計算誤差を重複と判定し、「重複を解除」後もエラーが残る不具合を修正しました。
- 全6分解能について音程ノートとドラムの再検査・プレビュー・MusicXML出力を検証する結合テストを追加しました。
- 全体テスト設計と開発・公開時の検証条件を更新しました。

## 利用条件と対応ソース

EarCopy Assist本体はMIT Licenseです。MuScriptorモデルはCC BY-NC 4.0と配布元の追加条件に従い、非商用用途に制限されます。BS-RoFormer SW Fixedの利用条件はアプリ内の取得画面で確認できます。

FFmpeg 8.1.2はGNU LGPL version 2.1 or laterです。FFmpeg、libsndfile、Python-SoXRの対応ソースは、同じReleaseの`EarCopyAssist-${VERSION}-copyleft-sources.zip`から取得できます。各配布ファイルのSHA-256は`SHA256SUMS.txt`に記載します。

## 検証と制約

ローカル環境でPythonテスト348件、UIテスト379件、型検査が成功しました。修正ビルドの起動スモークテストでは、Renderer応答不能時の終了が142 msで成功しました。バージョン更新後の配布パッケージは公開処理で起動試験とファイル検査を実行します。

全体テスト設計に記載した36件の機能横断試験は、追加実装・実行が残っています。今回の重複解除の修正は利用者による確認済みです。

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
