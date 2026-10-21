# 公開データセットによる採譜方式の比較

[English](TRANSCRIPTION_METHOD_BENCHMARK.en.md)

## 評価条件

2026-10-21に、EarCopy Assist 0.1.6、MuScriptor 0.4.0、PyTorch 2.5.1+cu121、NumPy 2.2.6を使用して測定した。Windows、Python 3.11.15、NVIDIA GeForce RTX 3060 Laptop GPUで実行した。

BabySlakh v2のTrack00001、Track00004、Track00010、Track00015、Track00018の60～80秒、合計100秒、参照1,427音符を使用した。アーカイブのMD5は`311096dc2bde7d61c97e930edbfc7f78`である。編成は[評価対象マニフェスト](../scripts/benchmark_cases/babyslakh_v2.json)を使用した。

MuScriptor medium、CUDA、float16、高精度、編成指定を使用し、同族楽器候補追加と重複音符削除を有効にした。分離はBS-RoFormer SW Fixedを使用した。分離後採譜ではdrums成分追加、音高の誤検出削減、分離音源の音量によるベロシティ設定をすべてONにした。drums成分の追加率は20%、Bassへ追加するdrumsのハイパスフィルターは350 Hz・4次Butterworthである。

## 評価指標

F1はMIDI音高、推定楽器、許容差以内の発音時刻を一対一対応させ、全出力音符と全参照音符から計算した。発音時刻の平均絶対誤差は、補正前の時刻差120 ms以内で対応できた同じ音符IDについて補正前後を比較した。補正ありの採譜を先に実行し、同じ分離音源・採譜イベントを再利用して補正なしと比較した。全10条件で対応する音符ID、音高、楽器、出力トラック、音符数は同一だった。

## 結果

| 方式 | 出力音符 | 時刻補正 | F1 @20 ms | F1 @50 ms | 発音時刻の平均絶対誤差 |
|---|---:|---|---:|---:|---:|
| 直接採譜 | 1,463 | なし | 0.2291 | 0.3682 | 18.41 ms |
| 直接採譜 | 1,463 | あり | 0.3370 | 0.3696 | 9.17 ms |
| 音源分離後採譜 | 1,301 | なし | 0.2771 | 0.3864 | 17.58 ms |
| 音源分離後採譜 | 1,301 | あり | 0.3607 | 0.3871 | 11.21 ms |

時刻誤差の対応数は直接採譜538組、音源分離後採譜543組である。平均絶対誤差の減少率は直接採譜50.16%、音源分離後採譜36.20%だった。分離後採譜は29入力中6入力で0 ms以外の補正を適用した。

補正ありの全5区間の処理時間は直接採譜90.44秒、音源分離後採譜209.34秒だった。原音の拍解析はCPU・2スレッドで実行し、分離後採譜で再利用した。分離音源と採譜イベントは新規計算した。時刻補正の計算と音符時刻の変更は合計6.84 msと11.40 msだった。測定の一部ではPyInstallerビルドとGTZAN評価が並行しており、他の実行との速度比較には使用できない。

曲別・入力別の指標とSHA-256は[評価結果JSON](benchmarks/data/muscriptor-application-onset-comparison.json)、実装条件は[拍解析・発音時刻補正の評価](developer/MUSCRIPTOR_EVALUATION.md)を参照する。

## 制約

対象は合成音源の5区間、mediumモデル、指定編成であり、実録音全般や曲全体の結果を示す値ではない。直接採譜と音源分離後採譜では対応できた音符の集合が異なるため、平均絶対誤差だけで分離の有無の優劣を判定できない。モデル重みは更新前と同一だが、実行ライブラリも変更しているため、前版との出力差をMuScriptorだけの効果とは解釈できない。

## 再現手順

1. `scripts/prepare_babyslakh_benchmark.ps1 -Destination app/benchmark/public-data`
2. `uv run python scripts/download_beat_model.py`
3. `uv run python -m scripts.evaluate_application_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --work-dir app/benchmark/latest-onset --output app/benchmark/application-onset-comparison.json`

新規計算には新しい作業ディレクトリを指定する。

## 参考資料

- [BabySlakh v2](https://doi.org/10.5281/zenodo.4603870)
