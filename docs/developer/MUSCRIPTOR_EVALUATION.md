# MuScriptorの拍解析・発音時刻補正の評価

[English](MUSCRIPTOR_EVALUATION.en.md)

## 対象

2026-10-21にMuScriptor 0.4.0を使用するEarCopy Assist 0.1.6を評価した。拍解析の方式比較は[テンポ・拍・小節先頭推定の公開評価](TEMPO_DOWNBEAT_EVALUATION.md)、直接採譜と音源分離後採譜の発音時刻補正は[公開データセットによる採譜方式の比較](../TRANSCRIPTION_METHOD_BENCHMARK.md)に記載する。

環境はWindows、Python 3.11.15、PyTorch 2.5.1+cu121、NumPy 2.2.6、Beat This! 1.1.0である。拍解析はCPU、採譜はNVIDIA GeForce RTX 3060 Laptop GPU、float16を使用した。small、medium、largeの採譜モデル重みとBeat This! final0は更新前と同一である。

## 拍解析

MuScriptor 0.4.0の`detect_grid`へローカルのfinal0を明示して呼び出す。`regularized_beats`が検出漏れと余分な拍を補正し、補正した拍列へ一定BPMを当てはめる。拍子は検出した小節先頭間の拍数から推定する。一定テンポと判定されない曲も平均BPMを返す。アプリのピアノロールと書き出しは曲全体で同じBPMを使用する。

GTZAN miniの開発用50曲と評価用50曲で、従来方式への切り替えを含めて比較した。方式の選択基準、指標間のトレードオフ、前回エラー音源の結果は上記の拍解析評価に記載する。

## 発音時刻補正

原音の拍解析を、直接採譜と音源分離後採譜の各入力、および音高検証用の参照採譜で使用する。共通後処理の後に、MuScriptorの`with_onset_delay`で発音時刻のずれを計算する。異なる発音開始時刻40点以上、位相の集中度0.5以上、補正量の絶対値40 ms以内などの公式条件を使用する。音源先頭をまたぐ補正は、音符の長さを維持して開始時刻0秒を下限とする。

採譜キャッシュは補正前のイベントを保存し、再利用時も補正を1回適用する。保存する入力別ノートは補正後の値であり、採譜オプションの再計算ではこの値を使用する。全5区間・直接採譜と音源分離後採譜の各条件で、補正前後の同じ音符IDを追跡して評価した。

## 記録と再現

[拍解析JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json)と[発音時刻補正JSON](../benchmarks/data/muscriptor-application-onset-comparison.json)に曲別指標、条件、モデル・音源のSHA-256を記録する。発音時刻補正JSONの`applicationCommitIsBase`は、記載コミットに対する作業中の変更を含む測定であることを示す。実行したアプリのPythonソースは`applicationSourceSha256`で識別する。再現手順は各評価文書を参照する。
