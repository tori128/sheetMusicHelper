# テンポ・拍・小節先頭推定の公開評価

[English](TEMPO_DOWNBEAT_EVALUATION.en.md)

## 概要

EarCopy Assistのテンポ、拍、小節先頭推定を、公開データセットGTZAN miniとBeat This! Annotations v1.1で評価した。条件選択に使用していない50曲において、BPM誤差4%以内の割合は0.7200、拍macro F1は0.7651、小節先頭macro F1は0.2665だった。

## 評価データ

[GTZAN mini](https://github.com/TempoBeatDownbeat/gtzan_mini)の30秒音源100曲と、[Beat This! Annotations v1.1](https://github.com/CPJKU/beat_this_annotations/tree/v1.1/gtzan)の拍・小節先頭注釈を使用した。参照拍は5,719件である。拍子ラベル別の曲数は4拍子95曲、3拍子4曲、2拍子1曲だった。

各ジャンル内でファイル名順の偶数番目50曲を条件選択用、奇数番目50曲を評価用とした。評価用50曲は、アルゴリズムの条件および閾値の選択に使用していない。

| 対象 | リビジョン |
|---|---|
| GTZAN mini | `a61439e86c13037011fde8e0f0743ec55c50bce3` |
| Beat This! Annotations | `890407d158078527ab396b49fea3c8a83e5734ee`（`v1.1`） |

## 推定方法

公開評価の測定時にはLibrosaとNumPyを使用した。Librosaのテンポ事前分布は初期値100 BPM、標準偏差1.0である。2倍テンポ候補は、オンセット再現率の増加が0.40以上、候補F1比が1.0以上、オンセット強度の自己相関比が0.90以上、候補BPMが220以下の場合に選択した。

2026年9月6日の修正では、初期推定の1.5倍と2倍を比較対象とし、候補の選択条件を、オンセット再現率の増加0.20以上、候補F1比0.75以上、自己相関比0.75以上へ変更した。候補BPMの上限は220である。ローカル検証音源の164、172、173 BPMは、変更前の82.0、86.0、86.3 BPMから、それぞれ164.0、172.0、173.0 BPMへ改善した。150 BPMの圧縮音源も99.5 BPMから150.0 BPMへ改善した。これら4音源は条件の調整と検証に使用した。以下の公開評価結果は変更前の条件に対応し、変更後のGTZAN miniによる精度は未測定である。

小節先頭推定では、2,048点STFTから150 Hz未満の帯域エネルギーを算出する。各拍位置の前後70 msにおける最大値を取得し、拍子内の拍番号ごとに平均値を算出する。帯域エネルギーは中央値を0、90パーセンタイルを1として0～2へ変換する。平均値が最高となる拍番号を小節先頭とする。

## 評価指標

参照BPMは、連続する参照拍の時間差の中央値から算出した。テンポ指標には、推定BPMの絶対誤差が参照BPMの4%以内である曲の割合と、絶対パーセント誤差の中央値を使用した。

推定BPMと推定小節先頭位置から、等間隔の拍列と小節先頭列を音源末尾まで生成した。参照時刻との差が70 ms以内のイベントを時刻順に一対一で対応させ、曲ごとのF1の平均をmacro F1とした。拍の評価には全参照拍、小節先頭の評価には拍番号1の参照拍を使用した。

## 結果

条件選択に使用していない評価用50曲の結果は次のとおりである。

| 指標 | 結果 |
|---|---:|
| BPM誤差4%以内 | 0.7200 |
| BPM絶対パーセント誤差中央値 | 0.3517% |
| 拍macro F1 | 0.7651 |
| 小節先頭macro F1 | 0.2665 |

測定値は[評価結果JSON](../benchmarks/data/gtzan-mini-tempo-downbeat.json)に記録している。

## 制約

- 評価データは各曲30秒であり、曲中のテンポ変化を評価対象としていない。
- 100曲中95曲が4拍子であり、2拍子と3拍子の評価曲数は合計5曲である。
- 小節先頭macro F1は0.2665である。推定結果はピアノロール上で確認し、必要に応じて音符を選択して「小節先頭に設定」を実行する必要がある。

## 再現手順

以下の手順は、チェックアウト中の実装を測定する。記録済みの結果と比較する場合は、使用した推定条件を併記する。

1. 評価音源と注釈を取得し、測定時のリビジョンを選択する。

   ```powershell
   git clone https://github.com/TempoBeatDownbeat/gtzan_mini app/benchmark/gtzan_mini
   git -C app/benchmark/gtzan_mini checkout a61439e86c13037011fde8e0f0743ec55c50bce3
   git clone https://github.com/CPJKU/beat_this_annotations app/benchmark/beat_this_annotations
   git -C app/benchmark/beat_this_annotations checkout 890407d158078527ab396b49fea3c8a83e5734ee
   ```

2. 100曲を測定する。

   ```powershell
   uv run python scripts/evaluate_tempo_downbeat.py `
     --audio-root app/benchmark/gtzan_mini/genres `
     --annotations-root app/benchmark/beat_this_annotations/gtzan/annotations/beats `
     --split all `
     --output app/benchmark/tempo-downbeat.json
   ```

3. 条件選択に使用していない50曲だけを測定する場合は、`--split evaluation`を指定する。
