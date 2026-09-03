EarCopy Assist ${VERSION} - Windows x64
=========================================

この配布物はポータブル版です。展開したフォルダーからEarCopyAssist.exeを起動します。

重要:
- Windows版は標準ZIPで配布し、2 GiBを超える場合は分割ZIPにします。
- 存在する.z01以降の全ボリュームと最後の.zipを同じフォルダーへ置いてください。
- 分割ZIPの展開には7-Zipなどの対応ソフトを使用します。
- MuScriptor small、medium、largeのモデル重みは同じReleaseのモデルアーカイブで配布します。
- BS-RoFormer SW Fixedが未配置の場合、アプリがライセンス`Unknown`の警告を表示します。
- MuScriptor公式モデルは非商用用途に制限されます。

使用開始まで:
1. 次のWindows本体ファイルを同じフォルダーへ置きます。
   EarCopyAssist-${VERSION}-win-x64.z01
   EarCopyAssist-${VERSION}-win-x64.z02以降（存在する場合は全て）
   EarCopyAssist-${VERSION}-win-x64.zip
2. 7-Zipなどの分割ZIP対応ソフトで、最後の.zipを開いて展開します。
3. 同じReleaseから次のモデルアーカイブを取得し、Windows本体を展開した親フォルダーへ
   展開します。
   EarCopyAssist-${VERSION}-muscriptor-small.zip
   EarCopyAssist-${VERSION}-muscriptor-medium.zip
   EarCopyAssist-${VERSION}-muscriptor-large.z01以降（存在する場合は全て）
   EarCopyAssist-${VERSION}-muscriptor-large.zip
4. EarCopyAssist.exeを起動し、MuScriptorモデルの利用条件を確認します。
5. 音源分離モデルが未配置の場合は、新規プロジェクト画面でライセンス`Unknown`、
   配布ページ、699412152 bytes、SHA-256を確認してダウンロードします。

初回に展開した後はEarCopyAssist.exeを直接起動します。EarCopyAssist.exeとresources
フォルダーは同じ場所に保ってください。
表示言語は新規プロジェクト画面または設定画面で日本語、英語、中国語から選択できます。

操作方法:
docs\USER_GUIDE.md
English operation guide:
docs\USER_GUIDE.en.md

ライセンス:
LICENSE.txt
外部ソフトウェアとモデルの利用条件・取得元（日本語）: THIRD_PARTY_NOTICES.md
Terms and sources for external software and models (English): THIRD_PARTY_NOTICES.en.md

配布元:
https://github.com/tori128/sheetMusicHelper

English instructions
--------------------

This is the portable Windows x64 package. Launch EarCopyAssist.exe from the extracted folder.
Select Japanese, English, or Chinese on the new-project screen or in Settings.

Getting started:
1. Put every EarCopyAssist-${VERSION}-win-x64.zNN volume and the final
   EarCopyAssist-${VERSION}-win-x64.zip in one folder.
2. Open the final .zip with 7-Zip or another split-ZIP-compatible archiver.
3. Download and extract the following model archives into the parent folder
   that contains the extracted Windows package:
   EarCopyAssist-${VERSION}-muscriptor-small.zip
   EarCopyAssist-${VERSION}-muscriptor-medium.zip
   Every EarCopyAssist-${VERSION}-muscriptor-large.zNN volume and the final
   EarCopyAssist-${VERSION}-muscriptor-large.zip
4. Launch EarCopyAssist.exe and review the MuScriptor model terms.
5. When the source-separation model is absent, review its `Unknown` license
   status, distribution page, 699412152-byte size, and SHA-256 on the
   new-project screen, then download it.

The MuScriptor model archives are included without modification and are
restricted to non-commercial use. BS-RoFormer SW Fixed is downloaded only
after the application displays its `Unknown` license status.

After extraction, launch EarCopyAssist.exe directly. Keep EarCopyAssist.exe
and resources together.

Operation guide:
docs\USER_GUIDE.en.md

License:
LICENSE.txt
Third-party terms and sources: THIRD_PARTY_NOTICES.en.md

Distributor:
https://github.com/tori128/sheetMusicHelper
