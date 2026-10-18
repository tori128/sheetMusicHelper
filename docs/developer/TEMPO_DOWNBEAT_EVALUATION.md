# テンポ・拍・小節先頭推定の公開評価

[English](TEMPO_DOWNBEAT_EVALUATION.en.md)

## 評価条件

2026-10-18に、MuScriptor 0.3.0とBeat This! final0による拍解析を、更新直前のLibrosa方式と比較した。GTZAN miniの30秒音源100曲のうち、各ジャンルでファイル名順の奇数番目に当たる50曲を評価した。今回の条件調整には使用していない。参照拍子を両方式へ同じ入力として与えた。

| データ | リビジョン |
|---|---|
| GTZAN mini | `a61439e86c13037011fde8e0f0743ec55c50bce3` |
| Beat This! Annotations v1.1 | `890407d158078527ab396b49fea3c8a83e5734ee` |

## 指標と結果

参照BPMは参照拍間隔の中央値から計算した。推定BPMと小節先頭位置から等間隔の拍列を生成し、70 ms以内で一対一対応した曲別F1を平均した。一定テンポを推定できない曲はBPM正解数に含めず、拍・小節先頭F1を0とした。

| 指標 | 更新直前のLibrosa方式 | MuScriptor 0.3.0 |
|---|---:|---:|
| テンポを出力した曲数 | 50 / 50 | 34 / 50 |
| BPM誤差4%以内 | 54% | 64% |
| 拍macro F1 | 0.7347 | 0.6515 |
| 小節先頭macro F1 | 0.3203 | 0.4917 |
| 50曲の処理時間 | 7.91秒 | 152.06秒 |

BPMと小節先頭の指標は改善したが、16曲で一定テンポを推定できず、拍macro F1は低下した。アプリはその場合も音源を保持し、BPMと拍子の手入力で採譜できる。拍子の自動推定精度は、この比較の測定対象に含めていない。処理時間はCPU実行・モデル読み込みを含む各条件1回の実測値である。

曲別指標は[評価結果JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json)、モデルと実装の条件は[拍解析・発音時刻補正の評価](MUSCRIPTOR_030_EVALUATION.md)を参照する。

## 再現手順

1. [GTZAN mini](https://github.com/TempoBeatDownbeat/gtzan_mini)と[Beat This! Annotations v1.1](https://github.com/CPJKU/beat_this_annotations/tree/v1.1/gtzan)を取得し、上記リビジョンを選択する。
2. `uv run python scripts/download_beat_model.py`で拍解析モデルを取得・検証する。
3. `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/tempo-downbeat.json`で50曲を測定する。
