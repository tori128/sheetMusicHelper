# EarCopy Assist ${VERSION}

EarCopy AssistのWindows x64用ポータブルパッケージです。自己解凍ZIPの`.exe`を実行して展開し、
`EarCopyAssist.exe`を起動してください。

ソースコミット: [${SOURCE_COMMIT}](https://github.com/tori128/sheetMusicHelper/tree/${SOURCE_COMMIT})

## 変更内容

- MuScriptorを0.4.0へ更新しました。
- 拍解析によるBPM・小節先頭位置・拍子の推定と、直接採譜・音源分離後採譜の発音時刻補正に対応しました。
- テンポが変動する音源でも平均BPMを使用して採譜できるようにしました。

## 利用条件と対応ソース

EarCopy Assist本体はMIT Licenseです。MuScriptorモデルはCC BY-NC 4.0と配布元の追加条件に従い、非商用用途に制限されます。BS-RoFormer SW Fixedの利用条件はアプリ内の取得画面で確認できます。

FFmpeg 8.1.2はGNU LGPL version 2.1 or laterです。FFmpeg、libsndfile、Python-SoXRの対応ソースは、同じReleaseの`EarCopyAssist-${VERSION}-copyleft-sources.zip`から取得できます。

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
