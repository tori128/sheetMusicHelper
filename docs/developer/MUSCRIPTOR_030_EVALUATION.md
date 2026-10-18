# MuScriptor 0.3.0の拍解析・発音時刻補正の比較

[English](MUSCRIPTOR_030_EVALUATION.en.md)

## 対象

2026-10-18に、従来のLibrosa方式（コミット`9d248cd7bd2cc06ecd270ca5b2faa91febae4d60`）と、MuScriptor 0.3.0の拍解析を比較した。発音時刻補正は、同一のMuScriptor medium採譜結果について補正前後を比較した。small、medium、largeの採譜モデル重みは更新前と同一である。

環境はWindows、Python 3.11.15、MuScriptor 0.3.0、Beat This! 1.1.0、PyTorch 2.2.2+cu121。拍解析はCPU、採譜はNVIDIA GeForce RTX 3060 Laptop GPU、float16を使用した。拍解析モデルはBeat This! final0、81,058,141 bytes、SHA-256は`8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`である。

## 拍解析

GTZAN miniの30秒音源100曲から、従来の評価設計と同じ各ジャンルのファイル名順で奇数番目の50曲を使用した。今回の条件調整には使用していない。GTZAN miniは`a61439e86c13037011fde8e0f0743ec55c50bce3`、Beat This! Annotations v1.1は`890407d158078527ab396b49fea3c8a83e5734ee`である。[Beat This!公式説明](https://github.com/CPJKU/beat_this#available-models)ではfinal0の学習対象からGTZANを除外している。

参照BPMは参照拍間隔の中央値から計算した。参照拍子を両方式へ同じ入力として与え、各方式のBPMと小節先頭位置からアプリが表示する等間隔の拍列・小節先頭列を生成した。時刻差70 ms以内で一対一対応し、曲ごとのF1を平均した。新方式が一定テンポを推定できない曲は、BPM正解数に含めず、拍と小節先頭のF1を0とした。

| 指標 | 従来方式 | MuScriptor 0.3.0 |
|---|---:|---:|
| テンポを出力した曲数 | 50 / 50 | 34 / 50 |
| BPM誤差4%以内 | 27 / 50（54%） | 32 / 50（64%） |
| 拍macro F1 | 0.7347 | 0.6515 |
| 小節先頭macro F1 | 0.3203 | 0.4917 |
| 50曲の処理時間 | 7.91秒 | 152.06秒 |

小節先頭とBPMの指標は改善したが、16曲で一定テンポを推定できず、拍macro F1は低下した。アプリでは、その場合も音源の選択を保持し、BPMと拍子の手入力で採譜できる。処理時間はモデルの読み込みを含む、この環境での1回の実測値である。

## 発音時刻補正

BabySlakh v2の既存評価設定`babyslakh_v2.json`に定義された5曲（Track00001、Track00004、Track00010、Track00015、Track00018）の60～80秒を使用した。合計100秒である。MuScriptor medium、CUDA、float16、高精度、編成指定、直接採譜を各区間1回実行した。共通後処理後の同一音符へ、MuScriptor公式の共通時刻ずれ補正を適用した。

時刻補正だけの効果を測るため、評価スクリプトは設定ファイルの`fixedInstruments`をモデルへ直接指定した。アプリ既定の同族楽器候補の追加とは条件が異なる。

MIDI音高と楽器が一致し、補正前の発音時刻差が120 ms以内となる音符をSciPyの線形割当で一対一対応させた。同じ537組について補正前後の時刻誤差を計算した。F1は許容差ごとに対応を再計算した。

| 指標 | 補正前 | 補正後 |
|---|---:|---:|
| 同じ537組の平均絶対誤差 | 18.02 ms | 8.44 ms |
| 発音時刻誤差の中央値（符号付き） | +17.30 ms | +4.69 ms |
| 絶対誤差95パーセンタイル | 28.10 ms | 27.00 ms |
| 発音時刻差20 ms以内のmicro F1 | 0.2547 | 0.3561 |
| 発音時刻差50 ms以内のmicro F1 | 0.3827 | 0.3827 |

5区間中4区間で補正が適用された。平均絶対誤差は53.13%減少したが、Track00015は16.08 msから16.30 msへ増加し、Track00018は補正量0 msだった。音高、楽器、音符数は補正前後で同一である。この5区間の結果は、他の音源・モデルサイズ・音源分離後採譜の改善率を保証する値ではない。

## 実装と条件

拍解析はMuScriptorの`detect_grid`へローカルのfinal0を明示して実行する。MuScriptorの一定テンポ判定を満たした結果を使用する。発音時刻補正は原音の拍解析を参照し、直接採譜と音源分離後採譜の各入力、参照用採譜の共通後処理後に適用する。補正量はMuScriptorの`with_onset_delay`で求める。異なる発音開始時刻40点以上、位相の集中度0.5以上、補正量の絶対値40 ms以内などの公式条件を使用する。音源先頭をまたぐ補正は、音符の長さを維持して開始時刻0秒を下限とする。

採譜キャッシュは補正前のイベントを保存し、再利用時も補正を1回適用する。保存する採譜入力別ノートは補正後の値であり、採譜オプションの再計算ではこの値を使用する。拍解析モデルはWindows本体の`resources/models/beat-this/final0.ckpt`へ同梱する。

## 記録と再現

各曲の指標、失敗した曲、音源と正解MIDIのSHA-256は[評価結果JSON](../benchmarks/data/muscriptor-030-beat-onset-comparison.json)を参照する。

従来方式は上記基準コミットを選択した別作業ディレクトリで、同じ50曲と評価スクリプトを使用して測定する。新方式は次の順で実行する。

1. `uv run python scripts/download_beat_model.py`で拍解析モデルを取得・検証する。
2. `uv run python scripts/evaluate_tempo_downbeat.py --audio-root <GTZAN-mini>/genres --annotations-root <annotations>/gtzan/annotations/beats --split evaluation --output app/benchmark/new-tempo.json`で拍解析を測定する。
3. `scripts/prepare_babyslakh_benchmark.ps1`で正解MIDI付き音源を取得する。
4. `uv run python -m scripts.evaluate_onset_correction --dataset-root app/benchmark/public-data/babyslakh_16k --output app/benchmark/onset-comparison.json`で発音時刻補正を測定する。

## アプリの検証

| 検証 | 結果 |
|---|---|
| `uv run pytest -q` | 344件成功、1件失敗、終了コード1 |
| `npm test -- --run` | 381件成功、終了コード0 |
| `npm run typecheck` | 終了コード0 |
| `npm run dist:win` | EXE生成成功、終了コード0 |
| `npm run smoke:packaged` | 8／48／96 kHzの3条件で終了コード0 |

Pythonの失敗は`test_portable_build_includes_release_documents`である。作業開始前からの未コミットのリリースノート編集が、既存テストの要求する`SHA-256`表記を削除している。同ファイルを変更せず、読み取り値だけを基準コミットの内容へ置き換えた単独試験では1件成功、終了コード0だった。

生成したEXEの内蔵バックエンドと実HTTP/SSEによる受入試験では、small／medium／largeの登録、同梱final0による拍解析、medium・CUDA・float16によるTrack00010の20秒採譜が成功した。アプリ既定の楽器候補追加を適用し、416音符を出力、発音時刻の共通ずれ15.9725 msを補正した。8／48／96 kHzの各EXE試験はローカル音声再生、SoundFont再生、MusicXML表示、100,000音符描画、終了時のプロセス残留0件を確認した。既存`UserData`の3ファイルはビルド前後のSHA-256が一致した。
