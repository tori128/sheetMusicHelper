# 公開データセットによる採譜方式の比較

[English](TRANSCRIPTION_METHOD_BENCHMARK.en.md)

## 評価条件

2026-10-18に、MuScriptor 0.3.0を使用するアプリの直接採譜と音源分離後採譜を比較した。

| 項目 | 条件 |
|---|---|
| データセット | BabySlakh v2 |
| 評価区間 | Track00001、Track00004、Track00010、Track00015、Track00018の60～80秒、合計100秒 |
| 参照音符 | MIDI音高・楽器を対応付ける1,427音符 |
| 採譜 | MuScriptor medium、CUDA、float16、高精度、編成指定 |
| 分離 | BS-RoFormer SW Fixed |
| 拍解析 | 原音をBeat This! final0で解析、CPU |

編成は[評価対象マニフェスト](../scripts/benchmark_cases/babyslakh_v2.json)の楽器情報を使用した。アプリ既定の同族楽器候補追加と重複音符削除を有効にした。分離後採譜はdrums成分追加、音高の誤検出削減、分離音源の音量によるベロシティ設定をすべてONにした。drums成分の追加率は20%、Bassへ追加するdrumsのハイパスフィルターは350 Hz・4次Butterworthである。

BabySlakh v2アーカイブのMD5は`311096dc2bde7d61c97e930edbfc7f78`である。

## 評価指標

F1はMIDI音高、推定楽器、許容差以内の発音時刻を一対一対応させ、全出力音符と全参照音符から計算した。発音時刻の平均絶対誤差は、補正前の時刻差120 ms以内で対応できた同じ音符IDについて補正前後を比較した。

## 結果

各方式で同じ分離音源と採譜イベントを使用し、MuScriptor 0.3.0の発音時刻補正の有無を比較した。

| 方式 | 出力音符 | 時刻補正 | F1 @20 ms | F1 @50 ms | 発音時刻の平均絶対誤差 |
|---|---:|---|---:|---:|---:|
| 直接採譜 | 1,444 | なし | 0.2306 | 0.3706 | 18.58 ms |
| 直接採譜 | 1,444 | あり | 0.3393 | 0.3720 | 9.10 ms |
| 音源分離後採譜 | 1,298 | なし | 0.2774 | 0.3868 | 17.58 ms |
| 音源分離後採譜 | 1,298 | あり | 0.3611 | 0.3875 | 11.22 ms |

時刻誤差の対応数は直接採譜539組、音源分離後採譜543組である。音源分離後採譜では平均絶対誤差が36.15%減少し、29の採譜入力中6入力へ0 ms以外の補正を適用した。5曲中3曲で誤差が減少し、1曲で増加、1曲は変化しなかった。50 ms許容の一致数は527音符から528音符だった。

補正ありの全5区間の実行時間は直接採譜91.65秒、音源分離後採譜239.93秒だった。直接採譜の後に分離後採譜を実行し、解析用WAVと原音の拍解析を再利用した。分離音源と採譜イベントは新規計算した。時刻補正の計算と音符の時刻変更は合計6.75 msと13.84 msだった。

曲別・入力別の指標、モデルと音源のSHA-256は[評価結果JSON](benchmarks/data/muscriptor-030-application-onset-comparison.json)、実装条件は[拍解析・発音時刻補正の評価](developer/MUSCRIPTOR_030_EVALUATION.md)を参照する。

## 制約

- 対象はBabySlakh v2の合成音源5区間、合計100秒であり、実録音全般や曲全体の結果を示す値ではない。
- モデルはmedium、推論条件はCUDA・float16、楽器はデータセットの情報から指定した。
- 方式間では対応できた音符の集合が異なるため、平均絶対誤差だけでは分離の有無の優劣を判定できない。
- 処理時間はNVIDIA GeForce RTX 3060 Laptop GPU環境で各条件1回の実測値である。

## 再現手順

1. `scripts/prepare_babyslakh_benchmark.ps1 -Destination app/benchmark/public-data`で評価音源を準備する。
2. `uv run python scripts/download_beat_model.py`で拍解析モデルを取得・検証する。
3. `uv run python -m scripts.evaluate_application_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --work-dir app/benchmark/latest-onset --output app/benchmark/application-onset-comparison.json`で比較する。新規計算には新しい作業ディレクトリを指定する。

## 参考資料

- [BabySlakh v2](https://doi.org/10.5281/zenodo.4603870)
