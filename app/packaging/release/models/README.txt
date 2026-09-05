BS-RoFormer SW Fixedは、新規プロジェクト画面でライセンス`Unknown`の警告を確認した後、
アプリが次の場所へ保存します。

  bs-roformer\sw-fixed\BS-Rofo-SW-Fixed.ckpt

取得元、ファイルサイズ、SHA-256は、配置先フォルダー内の
PLACE_MODEL_FILES_HERE.txtを参照してください。導入手順は..\README.md、利用条件は
..\THIRD_PARTY_NOTICES.mdを参照してください。

MuScriptor small、medium、largeは同じGitHub Releaseのモデル自己解凍ZIPを実行し、
Windows本体を展開した親フォルダーを展開先として選択します。

After the user acknowledges the `Unknown` license warning on the new-project
screen, the application stores BS-RoFormer SW Fixed at:

  bs-roformer\sw-fixed\BS-Rofo-SW-Fixed.ckpt

See PLACE_MODEL_FILES_HERE.txt for the source, file size, and SHA-256. See
..\README.md for setup and ..\THIRD_PARTY_NOTICES.en.md for license terms.

Run the MuScriptor small, medium, and large self-extracting ZIP files from the
same GitHub Release and select the parent folder of the extracted Windows package.

別のBS-RoFormer重みは、models\bs-roformer\sw-fixedへ重みファイルと対応するYAML構成ファイルを1組だけ配置できます。

To use another BS-RoFormer weight, place one weight and its YAML configuration
file in models\bs-roformer\sw-fixed.
