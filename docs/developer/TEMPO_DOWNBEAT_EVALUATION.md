# テンポ・拍・小節先頭推定の公開評価

[English](TEMPO_DOWNBEAT_EVALUATION.en.md)

## 評価条件

2026-10-21に、MuScriptor 0.4.0を使用するEarCopy Assist 0.1.6の拍解析を評価した。Windows、Python 3.11.15、PyTorch 2.5.1+cu121、NumPy 2.2.6、Beat This! 1.1.0を使用し、Beat This! final0をCPU・2スレッドで実行した。採譜モデルと拍解析モデルの重みは更新前と同一である。

GTZAN miniの30秒音源100曲をジャンル内のファイル名順で二分した。偶数番目の50曲で方式を選択し、その後、奇数番目の評価用50曲を測定した。参照拍子を各方式へ同じ入力として与えた。Beat This!による拍検出を曲ごとに1回実行し、検出した同じ拍時刻へ各拍グリッド計算を適用した。Librosa方式は別に実行した。

| データ | リビジョン |
|---|---|
| GTZAN mini | `a61439e86c13037011fde8e0f0743ec55c50bce3` |
| Beat This! Annotations v1.1 | `890407d158078527ab396b49fea3c8a83e5734ee` |

## 指標と結果

参照BPMは参照拍間隔の中央値から計算した。推定BPMと小節先頭位置から等間隔の拍列を生成し、70 ms以内で一対一対応した曲別F1を平均した。推定できない曲はBPM正解数に含めず、拍・小節先頭F1を0とした。

| 指標 | 従来のLibrosa方式 | 0.1.5の拍グリッド計算 | 0.1.6・MuScriptor 0.4.0 |
|---|---:|---:|---:|
| テンポを出力した曲数 | 50 / 50 | 41 / 50 | 50 / 50 |
| BPM誤差4%以内 | 54% | 74% | 84% |
| 拍macro F1 | 0.7347 | 0.7437 | 0.7629 |
| 小節先頭macro F1 | 0.3203 | 0.5517 | 0.5746 |
| 拍micro F1 | 0.7503 | 0.8234 | 0.7663 |
| 小節先頭micro F1 | 0.3342 | 0.5966 | 0.5623 |
| 出力したBPMの絶対百分率誤差の中央値 | 1.3305% | 0.1692% | 0.2825% |

0.4.0は50曲すべてにBPMを返し、42曲が誤差4%以内だった。前版の拍グリッド計算が棄却した9曲にも平均BPMを返す。BPM正解数と曲ごとの平均F1は増加したが、出力曲数が異なる条件でのBPM誤差中央値と、イベント数で集計するmicro F1は悪化した。すべての指標で改善したという結果ではない。拍子の自動推定精度は測定対象に含めていない。

## 従来方式への切り替えの比較

一定テンポと判定されない曲、または拍が不足する曲でLibrosaへ切り替える構成を比較した。判定にはMuScriptor 0.4.0の`steady`を使用した。

| 対象 | 指標 | 0.4.0単独 | Librosaへ切り替え |
|---|---|---:|---:|
| 開発用50曲 | BPM誤差4%以内 | 86% | 80% |
| 開発用50曲 | 拍macro F1 | 0.7612 | 0.8176 |
| 開発用50曲 | 小節先頭macro F1 | 0.6742 | 0.6640 |
| 評価用50曲 | BPM誤差4%以内 | 84% | 84% |
| 評価用50曲 | 拍macro F1 | 0.7629 | 0.8307 |
| 評価用50曲 | 小節先頭macro F1 | 0.5746 | 0.5315 |

開発用50曲でBPM正解率と小節先頭macro F1が高かった0.4.0単独を採用した。Librosaへの切り替えには拍macro F1の改善と小節先頭macro F1の低下があり、指標間のトレードオフがある。

## 実装と回帰確認

アプリ独自のSoft-L1回帰を削除し、ローカルのfinal0を明示してMuScriptor 0.4.0の`detect_grid`を呼ぶ。公式の`regularized_beats`が検出漏れの拍を補間し、余分な拍を除去する。8拍以上が得られれば、一定テンポと判定されない音源にも平均BPMを使用する。ピアノロール、クオンタイズ、書き出しは曲全体で同じBPMを使用する。

前回エラーが出た269.537秒の音源は、135.970154 BPM、4/4拍子、小節先頭0.620秒を出力した。曲全体を一定テンポとは判定していないが、音源を受け付けて平均BPMを設定できた。

処理時間の内訳は[評価結果JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json)に記録した。拍検出を共有し、測定の一部では回帰テスト、CUDA採譜、PyInstallerビルドが並行していたため、各方式を独立に実行した速度比較には使用できない。

## 再現手順

1. [GTZAN mini](https://github.com/TempoBeatDownbeat/gtzan_mini)と[Beat This! Annotations v1.1](https://github.com/CPJKU/beat_this_annotations/tree/v1.1/gtzan)を取得し、上記リビジョンを選択する。
2. `uv run python scripts/download_beat_model.py`で拍解析モデルを取得・検証する。
3. `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/tempo-downbeat.json`で現在のアプリの50曲を測定する。

発音時刻補正と採譜の測定は[拍解析・発音時刻補正の評価](MUSCRIPTOR_EVALUATION.md)を参照する。
