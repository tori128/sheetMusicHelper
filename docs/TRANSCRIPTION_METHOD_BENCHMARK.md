# 公開データセットによる採譜方式の比較

[English](TRANSCRIPTION_METHOD_BENCHMARK.en.md)

## 概要

EarCopy Assistの推奨既定値について、音源分離、ドラム成分による発音開始時刻の補助、音符検証、楽器指定方法が採譜精度へ与える影響を比較した。評価には公開データセットBabySlakh v2を使用した。

## 評価条件

| 項目 | 条件 |
|---|---|
| データセット | BabySlakh v2 |
| 評価区間 | `Track00001`、`Track00004`、`Track00010`、`Track00015`、`Track00018`の60～80秒、合計100秒 |
| 参照音符 | 音高評価1,433件、楽器込み評価1,427件 |
| 採譜モデル | MuScriptor medium |
| 推論 | CUDA、FP16 |
| 音源分離 | BS-RoFormer SW Fixed |

評価区間は[評価対象マニフェスト](../scripts/benchmark_cases/babyslakh_v2.json)に記録している。BabySlakh v2アーカイブのMD5は`311096dc2bde7d61c97e930edbfc7f78`である。

## 評価指標

50 ms基準のPrecision、Recall、Micro F1は、同じMIDI音高で発音開始時刻差が50 ms以内の音符を一対一で対応させて算出した。

発音時刻加重F1では、同じMIDI音高で発音開始時刻差が120 ms以内の音符を対応させる。発音開始時刻差が0 msなら1点、50 ms以上なら0点とし、0～50 msは直線補間する。対応音の合計点を`T`、出力音符数を`P`、参照音符数を`R`としたとき、発音時刻加重F1は`2T / (P + R)`である。表の発音時刻点は`T / 対応音数`、不一致率は`(過検出数 + 未検出数) / (P + R)`である。

楽器込みF1では、MIDI音高と発音開始時刻に加えて、出力トラックの楽器分類も一致条件に含めた。

## 採譜方式の比較

次の4条件を同じ5区間で比較した。

| 条件 | 処理 |
|---:|---|
| 1 | 音源分離を使用せず、原音を直接採譜 |
| 2 | 音源分離後、成分ごとに楽器候補を指定して採譜 |
| 3 | 条件2に加え、Bass、Piano、Guitar、Vocal、Otherへdrums成分を20%加算し、drumsと判定された音符を除外 |
| 4 | 条件3に加え、Bass、Piano、Guitar、Otherの音符を、drums成分を加算していない同一成分の前後2.5秒以内に存在する同音高で検証 |

Bassへ加算するdrums成分には、カットオフ周波数350 Hz、4次Butterworth高域通過フィルターを適用した。条件4は、発音開始時刻の誤差低減と音高の誤検出削減を有効にした推奨既定値に対応する。

| 方式 | 出力音符 | 一致 @50 ms | Precision @50 ms | Recall @50 ms | F1 @50 ms | 不一致率 | 発音時刻点 | 発音時刻加重F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1. 音源分離なし | 904 | 462 | 0.5111 | 0.3224 | 0.3954 | 0.5866 | 0.6065 | 0.2507 |
| 2. 音源分離＋楽器候補指定 | 1,350 | **731** | 0.5415 | **0.5101** | **0.5253** | **0.4337** | 0.6638 | **0.3759** |
| 3. 条件2＋drums成分20%加算 | 1,430 | 718 | 0.5021 | 0.5010 | 0.5016 | 0.4705 | 0.6672 | 0.3533 |
| 4. 条件3＋音符検証 | 1,284 | 702 | **0.5467** | 0.4899 | 0.5167 | 0.4575 | **0.6720** | 0.3646 |

音源分離と成分別の楽器候補指定を使用した条件2は、直接採譜より50 ms基準F1が`0.1299`、発音時刻加重F1が`0.1252`高く、不一致率が`0.1529`低かった。

条件4は条件2に対し、発音時刻点が`0.0082`高く、区間別95パーセンタイル発音開始時刻絶対誤差の中央値が69.7 msから31.0 msへ低下した。一方、50 ms基準F1は`0.0086`、Recallは`0.0202`、発音時刻加重F1は`0.0113`低く、不一致率は`0.0238`高かった。この100秒の評価では、drums成分による補助は発音開始時刻の誤差分布を改善したが、音符検出数を含む総合指標は条件2を上回らなかった。

条件4の音符検証は、条件3に対して出力音符を146件削減し、Precisionを`0.0446`、50 ms基準F1を`0.0151`、発音時刻加重F1を`0.0113`高め、不一致率を`0.0130`低下させた。Recallは`0.0111`低下した。

## 楽器指定方法の比較

同じ評価区間で、自動推定と正しい編成プリセットを比較した。発音時刻補助ありの条件は、前節のdrums成分加算と音符検証を使用した。

| 楽器指定方法 | 音高F1 @50 ms | 楽器込みF1 @50 ms |
|---|---:|---:|
| 自動推定＋発音時刻補助 | 0.5167 | 0.3563 |
| 正しい編成プリセット、発音時刻補助なし | 0.5134 | 0.4322 |
| 正しい編成プリセット＋発音時刻補助 | **0.5411** | **0.4653** |
| 正しい編成プリセット＋発音時刻補助、選択音色のみ | 0.5409 | 0.4608 |

正しい編成プリセットと発音時刻補助の組み合わせは、自動推定と発音時刻補助の組み合わせより、音高F1が`0.0244`、楽器込みF1が`0.1090`高かった。同系統の楽器候補を含めた場合と選択音色だけに限定した場合の差は、音高F1が`0.0002`、楽器込みF1が`0.0045`だった。

## 結論

この評価では、音源分離後に成分別の楽器候補を指定する方式が、直接採譜より音高F1、Recall、発音時刻加重F1で高い値を示した。正しい編成プリセットは、自動推定より楽器込みF1が高かった。

条件4のdrums成分による発音時刻補助は、95パーセンタイル発音開始時刻誤差を低下させた。音符検証はdrums成分加算後の過検出を削減した。ただし、条件4の50 ms基準F1と発音時刻加重F1は、音源分離と楽器候補指定だけを使用した条件2より低い。用途に応じて、発音開始時刻の安定性とRecallの差を考慮する必要がある。

## 制約

- BabySlakh v2は合成音源によるデータセットであり、実録音の残響、演奏ノイズ、マイク特性を網羅しない。
- 評価対象は5区間、合計100秒である。
- 採譜モデルはMuScriptor medium、推論条件はCUDA FP16に限定した。
- 正しい編成プリセットの評価ではデータセットの楽器情報を使用した。利用者が異なる編成を指定した場合は同じ結果にならない。

## 再現手順

1. BabySlakh v2を準備する。

   ```powershell
   .\scripts\prepare_babyslakh_benchmark.ps1 -Destination app/benchmark/public-data
   ```

2. 4条件の採譜方式を評価する。

   ```powershell
   uv run python scripts/run_public_transcription_benchmark.py `
     --manifest scripts/benchmark_cases/babyslakh_v2.json `
     --dataset-root app/benchmark/public-data/babyslakh_16k `
     --model models/muscriptor/medium/model.safetensors `
     --stem-model models/bs-roformer/sw-fixed/BS-Rofo-SW-Fixed.ckpt `
     --backend CUDA --dtype float16 `
     --output-json docs/benchmarks/data/babyslakh-medium-fp16.json
   ```

3. 楽器指定方法を評価する。

   ```powershell
   uv run python scripts/run_routing_policy_benchmark.py `
     --manifest scripts/benchmark_cases/babyslakh_v2.json `
     --dataset-root app/benchmark/public-data/babyslakh_16k `
     --model models/muscriptor/medium/model.safetensors `
     --stem-model models/bs-roformer/sw-fixed/BS-Rofo-SW-Fixed.ckpt `
     --backend CUDA --dtype float16 `
     --work-dir app/benchmark/routing-results `
     --output-json docs/benchmarks/data/babyslakh-medium-fp16-routing-policy.json
   ```

評価結果は[採譜方式の比較結果](benchmarks/data/babyslakh-medium-fp16.json)と[楽器指定方法の比較結果](benchmarks/data/babyslakh-medium-fp16-routing-policy.json)に保存している。

## 参考資料

- [BabySlakh v2](https://doi.org/10.5281/zenodo.4603870)
- [Slakh](https://doi.org/10.5281/zenodo.4599666)
- [mir_eval](https://craffel.github.io/mir_eval/)
