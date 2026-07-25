# EarCopy Assist 機能・技術仕様

| 項目 | 内容 |
|---|---|
| 文書版 | 1.1 |
| 対象OS | Windows 10 / Windows 11 64-bit |
| 配布形態 | Windowsポータブルアプリケーション |
| 採譜エンジン | MuScriptor |
| 主要出力 | Standard MIDI File Format 1、MusicXML、4ステムWAV |
| 利用形態 | ローカルデスクトップアプリケーション |

---

## 1. 目的

本アプリケーションは、楽曲音源をMuScriptorで自動採譜し、採譜結果のパート割り当てを統合ピアノロール上で修正して、MuseScore等へ受け渡せるMIDIおよびMusicXMLを生成するWindows向けデスクトップアプリケーションである。

中心機能は、MuScriptorが異なる楽器へ割り当てたノートをユーザーがまとめて選択し、正しいパートへ移動できる編集機能とする。採譜結果はMuseScore General SoundFontで即時再生し、同じ再生位置の原音とワンタッチで切り替えて比較できる。

音源分離機能は4ステム方式としてシステム構成に組み込み、直接採譜と4ステム前処理付き採譜を同一のプロジェクト形式および編集画面で扱う。

---

## 2. システム全体像

### 2.1 利用フロー

```text
音源ファイルを選択
    ↓
編成プリセットを選択・編集
    ↓
MuScriptorモデルと推論バックエンドを選択
    ↓
BPM自動推定・拍子設定
    ↓
直接採譜 または 4ステム分離後の採譜
    ↓
統合ピアノロール／ドラムロールへ表示
    ↓
ノート選択・パート再割り当て・全体クオンタイズ
    ↓
原音／SoundFont再生を切り替えて確認
    ↓
プロジェクト保存
    ↓
SMF・MusicXML・分離ステムWAVを書き出し
```

### 2.2 ソフトウェア構成

```text
┌──────────────────────────────────────────────┐
│ Electron デスクトップシェル                 │
│  ├─ ウィンドウ管理                          │
│  ├─ ファイルダイアログ                      │
│  ├─ ポータブルデータ領域                    │
│  └─ Pythonサービスの起動・終了              │
├──────────────────────────────────────────────┤
│ React / TypeScript フロントエンド            │
│  ├─ プロジェクト編集状態                    │
│  ├─ プリセット編集                          │
│  ├─ 統合ピアノロール／ドラムロール          │
│  ├─ ノート選択・パート移動                  │
│  ├─ SoundFont再生                           │
│  └─ 原音／採譜結果の同期再生                │
├──────────────────────────────────────────────┤
│ Python ローカルサービス                     │
│  ├─ 音源読み込み・変換                      │
│  ├─ BPM推定                                 │
│  ├─ MuScriptor推論                          │
│  ├─ 4ステム音源分離                         │
│  ├─ SMF生成                                 │
│  └─ MusicXML生成                            │
├──────────────────────────────────────────────┤
│ 推論バックエンド                            │
│  ├─ PyTorch CPU                             │
│  └─ PyTorch CUDA                            │
└──────────────────────────────────────────────┘
```

### 2.3 採用技術

| レイヤ | 技術 |
|---|---|
| デスクトップシェル | Electron |
| UI | React、TypeScript、Vite |
| ピアノロール描画 | Canvas 2D、可視範囲描画、時間・音高インデックス |
| 状態管理 | TypeScriptのプロジェクトストア |
| ローカルAPI | FastAPI、Server-Sent Events |
| 採譜 | MuScriptor Python API |
| 推論 | PyTorch CPU / CUDA |
| BPM推定 | librosaのオンセット強度・ビート追跡 |
| 音源変換 | FFmpeg |
| SoundFont再生 | SpessaSynth AudioWorklet、MuseScore General SF3 |
| 音源分離 | SCNet Large 4ステム分離 |
| MIDI生成 | mido |
| MusicXML生成 | 独自MusicXML 4.0ライター |

---

## 3. 基本概念

### 3.1 採譜対象、出力パート、再生音色

アプリ内部では、次の3要素を分けて管理する。

| 要素 | 役割 | 例 |
|---|---|---|
| 採譜対象 | MuScriptorへ指定する楽器グループ | `distorted_electric_guitar` |
| 出力パート | 編集画面と書き出しファイル上のトラック | Distorted Electric Guitar |
| 再生音色 | SoundFontへ指定するGM Program | Distortion Guitar、内部Program 30 |

プリセット内の各出力パートは、1つのMuScriptor楽器グループと1対1で関連付ける。再生音色とMIDI Programは楽器グループから自動決定する。ユーザーが操作する項目は、出力パート名、採譜対象、表示色、並び順とする。

### 3.2 トラック構成

1プロジェクトは最大16トラックで構成する。

- 音程パート：最大15トラック
- ドラムパート：最大1トラック
- 音程パートのMIDIチャンネル：1～9、11～16
- ドラムパートのMIDIチャンネル：10
- 1トラックにつき1つのMuScriptor楽器グループ
- プリセット内の楽器グループIDは一意

`drums`はドラムパートとして扱う。`timpani`および`chromatic_percussion`は音程パートとして扱う。

### 3.3 時間軸

プロジェクトの基準時刻は秒とし、MIDIおよび楽譜用の位置をPPQ 480のtickへ変換する。

```text
PPQ = 480
startTick = round(startSec × BPM × PPQ ÷ 60)
endTick   = round(endSec   × BPM × PPQ ÷ 60)
```

各ノートはMuScriptor出力時刻と編集後時刻を保持する。

- `rawStartSec` / `rawEndSec`：MuScriptor出力
- `startSec` / `endSec`：編集およびクオンタイズ後

BPMを手動変更した時点で、小節線、拍線、tick表示を再計算する。クオンタイズ実行時に編集後時刻を新しいグリッドへ更新する。

---

## 4. 編成プリセット

### 4.1 プリセット共通仕様

プリセットはJSONファイルとして保存し、次の項目を持つ。

| 項目 | 内容 |
|---|---|
| `id` | UUID |
| `name` | 画面表示名 |
| `tracks` | 最大16件のトラック定義 |
| `track.displayName` | トラック表示名 |
| `track.instrumentId` | MuScriptor楽器グループID |
| `track.color` | `#RRGGBB`形式の表示色 |
| `track.order` | 表示順 |
| `track.kind` | `pitched` または `drums` |

プリセット編集画面では、トラック追加、削除、並び替え、名称変更、楽器グループ選択、色変更、プリセット名変更、別名保存を行う。

組み込みプリセットの編集開始時はユーザー領域へ複製し、編集版をユーザープリセットとして保存する。

### 4.2 汎用バンド

| 順 | 表示名 | MuScriptor ID |
|---:|---|---|
| 1 | Piano | `acoustic_piano` |
| 2 | Distorted Electric Guitar | `distorted_electric_guitar` |
| 3 | Electric Bass | `electric_bass` |
| 4 | Vocal | `voice` |
| 5 | Drums | `drums` |

### 4.3 弦楽四重奏

| 順 | 表示名 | MuScriptor ID |
|---:|---|---|
| 1 | Violin I / II | `violin` |
| 2 | Viola | `viola` |
| 3 | Cello | `cello` |

ヴァイオリン第1・第2パートは1つのViolinトラックへ統合する。

### 4.4 吹奏楽

| 順 | 表示名 | MuScriptor ID |
|---:|---|---|
| 1 | Flutes | `flutes` |
| 2 | Oboe | `oboe` |
| 3 | Bassoon | `bassoon` |
| 4 | Clarinet | `clarinet` |
| 5 | Soprano / Alto Sax | `soprano_and_alto_sax` |
| 6 | Tenor Sax | `tenor_sax` |
| 7 | Baritone Sax | `baritone_sax` |
| 8 | Trumpet | `trumpet` |
| 9 | French Horn | `french_horn` |
| 10 | Trombone | `trombone` |
| 11 | Tuba | `tuba` |
| 12 | Contrabass | `contrabass` |
| 13 | Timpani | `timpani` |
| 14 | Chromatic Percussion | `chromatic_percussion` |
| 15 | Percussion | `drums` |

### 4.5 オーケストラ

| 順 | 表示名 | MuScriptor ID |
|---:|---|---|
| 1 | Flutes | `flutes` |
| 2 | Oboe | `oboe` |
| 3 | Clarinet | `clarinet` |
| 4 | Bassoon | `bassoon` |
| 5 | French Horn | `french_horn` |
| 6 | Trumpet | `trumpet` |
| 7 | Trombone | `trombone` |
| 8 | Tuba | `tuba` |
| 9 | Violin | `violin` |
| 10 | Viola | `viola` |
| 11 | Cello | `cello` |
| 12 | Contrabass | `contrabass` |
| 13 | Orchestral Harp | `orchestral_harp` |
| 14 | Timpani | `timpani` |
| 15 | Chromatic Percussion | `chromatic_percussion` |
| 16 | Percussion | `drums` |

### 4.6 アニメソング

| 順 | 表示名 | MuScriptor ID |
|---:|---|---|
| 1 | Piano | `acoustic_piano` |
| 2 | Strings | `string_ensemble` |
| 3 | Acoustic Guitar | `acoustic_guitar` |
| 4 | Distorted Electric Guitar | `distorted_electric_guitar` |
| 5 | Electric Bass | `electric_bass` |
| 6 | Drums | `drums` |
| 7 | Timpani | `timpani` |
| 8 | Vocal | `voice` |
| 9 | Brass Section | `brass_section` |

---

## 5. 楽器グループと再生音色の対応

画面ではGM Programを1始まりで表示し、内部では0始まりで保持する。

| MuScriptor ID | 日本語表示 | GM音色 | 内部Program |
|---|---|---:|---:|
| `acoustic_piano` | アコースティックピアノ | 1 | 0 |
| `electric_piano` | エレクトリックピアノ | 5 | 4 |
| `chromatic_percussion` | 鍵盤打楽器 | 10 | 9 |
| `organ` | オルガン | 20 | 19 |
| `acoustic_guitar` | アコースティックギター | 25 | 24 |
| `clean_electric_guitar` | クリーンエレキギター | 28 | 27 |
| `distorted_electric_guitar` | ディストーションギター | 31 | 30 |
| `acoustic_bass` | アコースティックベース | 33 | 32 |
| `electric_bass` | エレクトリックベース | 34 | 33 |
| `violin` | ヴァイオリン | 41 | 40 |
| `viola` | ヴィオラ | 42 | 41 |
| `cello` | チェロ | 43 | 42 |
| `contrabass` | コントラバス | 44 | 43 |
| `orchestral_harp` | オーケストラハープ | 47 | 46 |
| `timpani` | ティンパニ | 48 | 47 |
| `string_ensemble` | ストリングス | 49 | 48 |
| `synth_strings` | シンセストリングス | 51 | 50 |
| `voice` | ボーカル／クワイア | 53 | 52 |
| `orchestra_hit` | オーケストラヒット | 56 | 55 |
| `trumpet` | トランペット | 57 | 56 |
| `trombone` | トロンボーン | 58 | 57 |
| `tuba` | チューバ | 59 | 58 |
| `french_horn` | フレンチホルン | 61 | 60 |
| `brass_section` | ブラスセクション | 62 | 61 |
| `soprano_and_alto_sax` | ソプラノ／アルトサックス | 66 | 65 |
| `tenor_sax` | テナーサックス | 67 | 66 |
| `baritone_sax` | バリトンサックス | 68 | 67 |
| `oboe` | オーボエ | 69 | 68 |
| `english_horn` | イングリッシュホルン | 70 | 69 |
| `bassoon` | ファゴット | 71 | 70 |
| `clarinet` | クラリネット | 72 | 71 |
| `flutes` | フルート群 | 74 | 73 |
| `synth_lead` | シンセリード | 81 | 80 |
| `synth_pad` | シンセパッド | 90 | 89 |
| `drums` | ドラム／打楽器 | MIDIチャンネル10 | — |

再生ベロシティおよびSMF出力ベロシティの初期値は100とする。

---

## 6. 画面構成

### 6.1 画面一覧

| 画面 | 主な役割 |
|---|---|
| モデル設定画面 | ローカルモデル登録、推論バックエンド選択 |
| 新規プロジェクト画面 | 音源、プリセット、処理モード、拍子の指定 |
| 採譜進行画面 | 処理段階、進捗、ストリーミングノートの表示 |
| メイン編集画面 | ピアノロール編集、比較再生、保存、書き出し |
| プリセット編集画面 | 最大16トラックの編成定義 |
| アプリ設定画面 | 音声出力デバイス、キャッシュ、表示設定 |
| ライセンス画面 | アプリおよび第三者ライセンスの表示 |

### 6.2 新規プロジェクト画面

| 項目 | 仕様 |
|---|---|
| 音源ファイル | ファイル選択およびドラッグ＆ドロップ |
| 対応形式 | WAV、MP3、FLAC、OGG、M4A、AAC |
| プロジェクト名 | 音源ファイル名を初期値として編集可能 |
| 編成プリセット | 組み込み／ユーザープリセットから選択 |
| プリセット編集 | 選択中プリセットを編集画面で開く |
| 処理モード | 直接採譜、4ステム前処理付き採譜 |
| MuScriptorモデル | 登録済みローカルモデルから選択 |
| 推論バックエンド | Auto、CPU、CUDA |
| 拍子 | 分子1～12、分母2・4・8・16 |
| BPM | 音源読み込み後に自動推定値を表示し、数値編集可能 |
| 実行 | プロジェクト領域を作成して採譜開始 |

### 6.3 メイン編集画面

```text
┌──────────────────────────────────────────────────────────────┐
│ ファイル / プリセット / 設定                                │
├──────────────────────────────────────────────────────────────┤
│ 再生  停止  時刻  [原音][採譜結果]  BPM  拍子  Quantize 実行 │
├───────────────┬──────────────────────────────────────────────┤
│ トラック一覧  │ [音程パート] [ドラム]                       │
│ 色・名称      │ 時間ルーラー、小節線、拍線                   │
│ Mute / Solo   │                                              │
│               │ 統合ピアノロール／ドラムロール               │
│               │                                              │
├───────────────┴──────────────────────────────────────────────┤
│ ホイール横移動  軸別ズーム  スクロールバー  処理状態         │
└──────────────────────────────────────────────────────────────┘
```

### 6.4 トラック一覧

全トラックをプリセット順に表示する。各行は次の要素を持つ。

- トラック色
- トラック表示名
- Muteボタン
- Soloボタン

1つ以上のSoloが有効な状態では、Solo対象トラックをSoundFont再生へ送る。Muteは対象トラックのSoundFont再生ゲインを0へ設定する。状態はプロジェクトへ保存する。

### 6.5 音程パート表示

- 全音程パートのノートを1つのピアノロールへ重ねて表示する。
- ノート色は所属トラック色を使用する。
- 縦軸はMIDIノート0～127とし、鍵盤表示、音名表示、縦スクロールを備える。
- 横軸は秒、小節、拍を表示する。
- 再生位置を縦線で表示する。
- 表示範囲内のノートをCanvasへ描画する。
- マウスホイールで時間方向へスクロールする。
- Ctrl+マウスホイールで時間方向、Shift+マウスホイールで音高方向を拡大縮小する。
- 拡大縮小時はマウスポインター位置の時刻または音高行を維持する。

### 6.6 ドラム表示

- `drums`トラックのノートを専用ドラムロールへ表示する。
- 縦軸はGM Percussionの名称とMIDIノート番号を表示する。
- 横軸、小節線、拍線、再生位置、ズーム、スクロールは音程パート表示と共通化する。
- ドラムノートはドラムトラック色で表示する。

---

## 7. ノート選択とパート再割り当て

### 7.1 選択操作

| 操作 | 動作 |
|---|---|
| ノートをクリック | そのノートを単独選択し、所属トラックの音色で短く試聴 |
| Shift＋ノートをクリック | 現在の選択へノートを追加し、追加したノートを短く試聴 |
| 空白をドラッグ | 矩形と交差するノートを選択 |
| Shift＋空白をドラッグ | 矩形選択結果を現在の選択へ追加 |
| 空白をクリック | 選択状態を解除 |
| 選択ノートを右クリック | パート移動メニューを表示 |

選択ノートは輪郭線と明度変化で識別する。矩形選択では複数ノートを同時発音しない。

### 7.2 パート移動メニュー

右クリックメニューへ、プロジェクト内の音程パートをプリセット順で表示する。各候補にはトラック色と表示名を付ける。

パート移動時は次の値を保持する。

- ノートID
- 音高
- 開始時刻
- 終了時刻
- ベロシティ
- MuScriptorが出力した元楽器ID

更新対象は現在の所属トラックIDとする。

### 7.3 同一ノートの上書き

同一ノート判定キーは次の3要素とする。

```text
移動先トラックID
MIDIノート番号
開始tick
```

開始tickは現在のBPMとPPQ 480で算出する。移動先に同じキーのノートが存在する場合、移動ノートの開始・終了時刻と属性を採用する。

複数の選択ノートが同じキーへ集約される場合は、終了tickが最大のノートを採用する。処理後も移動ノートを選択状態として表示する。

---

## 8. BPM、拍子、クオンタイズ

### 8.1 BPM推定

音源読み込み時に次の処理を行う。

1. 音源をモノラル22.05 kHzへダウンサンプリングする。
2. オンセット強度包絡を算出する。
3. 全曲のビート候補から固定BPMを推定する。
4. 半テンポ、倍テンポ、3:2系の候補をオンセット列へ照合し、検出オンセットの
   取りこぼしとオンセットのない空拍が最少になる候補を選ぶ。
5. 半テンポ候補が最良になった場合でも、倍テンポ候補がオンセット強度を15ポイント
   以上多く説明し、候補スコアを75%以上維持する場合は倍テンポを採用する。
6. 選択した候補の全曲拍列へ直線を当てはめ、固定BPMを小数第1位まで補正する。
7. ユーザーがBPM値を数値入力で修正する。

入力範囲は20.0～300.0 BPMとする。

拍位置解析では検出した拍の1件を仮の小節先頭として扱う。ユーザーはノートを
1件選択し、そのノート開始位置を小節先頭へ設定できる。この操作はBPMを変更せず、
現在の拍子に対する小節位相だけを更新する。曲中のテンポ変更は扱わない。

### 8.2 拍子

拍子はユーザー設定とし、分子1～12、分母2・4・8・16を選択できる。拍子は次の処理へ使用する。

- 小節線と拍線の描画
- 小節番号の表示
- SMFのTime Signatureメタイベント
- MusicXMLの小節構成

### 8.3 クオンタイズ候補

| 表示 | tick幅 |
|---|---:|
| 1/4 | 480 |
| 1/8 | 240 |
| 1/16 | 120 |
| 1/32 | 60 |
| 1/8三連 | 160 |
| 1/16三連 | 80 |

### 8.4 クオンタイズ処理

クオンタイズはプロジェクト内の全ノートへ一括適用する。対象には音程パートとドラムパートを含む。

```text
quantizedTick = round(originalTick ÷ gridTick) × gridTick
```

開始tickと終了tickの両方を丸める。丸め後の終了tickは開始tick＋1グリッド以上とする。更新したtickを現在のBPMで秒へ戻し、`startSec`と`endSec`へ保存する。

---

## 9. 採譜処理

### 9.1 音源読み込み

1. 元音源のSHA-256、長さ、サンプルレート、チャンネル数を取得する。
2. プロジェクトキャッシュへ44.1 kHz、32-bit float WAVを生成する。
3. 元音源は比較再生用としてファイルストリーミングする。
4. 変換済みWAVはBPM推定、MuScriptor、音源分離で共有する。

キャッシュキーは元音源SHA-256と変換条件から生成する。

### 9.2 直接採譜モード

1. プリセット内の全MuScriptor楽器グループIDを取得する。
2. グループID一覧をMuScriptorの`instruments`へ渡す。
3. MuScriptorのNoteStart、NoteEnd、ProgressイベントをSSEでフロントエンドへ送る。
4. NoteStartとNoteEndをイベントindexで結合する。
5. 楽器グループIDと一致する出力トラックへノートを登録する。
6. `drums`イベントをドラムトラックへ登録する。
7. ベロシティ100を設定する。
8. 採譜完了後に全ノートを開始時刻順へ整列する。

MuScriptorの5秒チャンク進捗を採譜進行画面へ反映し、完了済みノートをピアノロールへ順次追加する。

### 9.3 4ステム前処理付き採譜モード

SCNet Largeモデルで、次の4ステムを生成する。

- `drums.wav`
- `bass.wav`
- `vocals.wav`
- `other.wav`

CUDAが利用可能な環境ではSCNet Largeの推論をCUDAで実行する。CUDAメモリが不足した場合は、
同じFP32モデルをCPUで再実行する。

プリセットの採譜対象を次のように振り分ける。

| ステム | MuScriptorへ渡す楽器グループ |
|---|---|
| drums | `drums`、`timpani`、`chromatic_percussion`のうちプリセットに含まれるもの |
| bass | `acoustic_bass`、`electric_bass`、`contrabass`のうちプリセットに含まれるもの |
| vocals | `voice` |
| other | 上記以外の全音程パート |

各ステムのMuScriptorイベントを共通ノート形式へ変換し、トラックIDで統合する。統合後の編集、再生、保存、SMF出力、MusicXML出力は直接採譜モードと同じ処理を使用する。

### 9.4 採譜ジョブ状態

| 状態 | 画面表示 |
|---|---|
| `preparing_audio` | 音源を準備中 |
| `estimating_tempo` | BPMを解析中 |
| `separating` | 4ステムへ分離中 |
| `transcribing` | 採譜中、完了チャンク数を表示 |
| `building_project` | プロジェクトを構築中 |
| `completed` | 編集画面を表示 |
| `failed` | 原因、処理段階、ログ参照先を表示 |
| `cancelled` | プロジェクト開始画面へ戻る |

---

## 10. 再生機能

### 10.1 再生ソース

再生ソースは次の2種類とする。

- 原音
- 採譜結果

上部ツールバーの2ボタンで切り替える。切り替え時は再生位置と再生状態を保持し、10 msのゲインランプでソースを切り替える。

### 10.2 マスタークロック

元音源を読み込んだHTMLMediaElementの`currentTime`をマスタークロックとする。採譜結果再生中も元音源をゲイン0で進行させ、SoundFontシンセサイザーを同じ時刻へ同期する。

- スケジューラ周期：25 ms
- 先読み時間：100 ms
- シーク時：予定イベントを再構築
- 停止時：時刻0へ移動
- 再生カーソル更新：requestAnimationFrame

### 10.3 SoundFont再生

- SoundFont：MuseScore General SF3
- シンセサイザー：SpessaSynth AudioWorklet
- Program：楽器グループ対応表から自動選択
- ベロシティ：100
- ドラム：MIDIチャンネル10
- Mute／Solo：トラック単位のチャンネルゲインへ反映

MuseScore General SF3は`resources/soundfonts/`へ配置し、アプリ起動時に読み込む。音色サンプルは採譜完了後に使用音高単位でプリウォームする。

### 10.4 出力デバイス

原音とSoundFontのマスター出力をWebAudioのMediaStreamへまとめ、出力用HTMLMediaElementへ接続する。設定画面でWindowsのオーディオ出力デバイスを列挙し、選択したデバイスIDを`setSinkId`へ設定する。

オーディオバックエンドは共通インターフェースで構成し、Windows標準オーディオ出力とASIOバックエンドを同じトランスポート制御へ接続できる構造とする。

---

## 11. モデル管理と推論バックエンド

### 11.1 MuScriptorモデル登録

モデル設定画面でローカルの`.safetensors`を登録する。登録情報は次の項目を持つ。

| 項目 | 内容 |
|---|---|
| プロファイル名 | ユーザー指定名 |
| モデルファイル | 絶対パスまたは`models/muscriptor/`からの相対パス |
| ファイル名 | 表示用 |
| SHA-256 | モデル識別 |
| バリアント | small / medium / large |
| dtype | float32 / float16 |
| 既定バックエンド | Auto / CPU / CUDA |

登録時にモデル構造を検証し、ロード結果、推定バリアント、必要メモリ情報を表示する。

### 11.2 バックエンド共通インターフェース

```python
class TranscriptionBackend(Protocol):
    def capabilities(self) -> BackendCapabilities: ...
    def load(self, model_path: Path, dtype: str) -> None: ...
    def transcribe(
        self,
        audio_path: Path,
        instruments: list[str],
        on_event: Callable[[TranscriptionEvent], None],
    ) -> None: ...
    def unload(self) -> None: ...
```

### 11.3 バックエンド選択

| 選択値 | 動作 |
|---|---|
| Auto | CUDA、CPUの順に利用可能なバックエンドを選択 |
| CPU | PyTorch CPUで実行 |
| CUDA | PyTorch CUDAで実行 |

CPUとCUDAは同じプロジェクト形式、プリセット形式、UI、ローカルAPIを使用する。

---

## 12. プロジェクト保存

### 12.1 ファイル形式

拡張子は`.ecaproj`とし、UTF-8 JSONで保存する。

```json
{
  "formatVersion": 1,
  "appVersion": "1.0.0",
  "projectId": "uuid",
  "name": "song-name",
  "sourceAudio": {},
  "tempo": {},
  "transcription": {},
  "tracks": [],
  "notes": [],
  "stems": [],
  "viewState": {}
}
```

### 12.2 プロジェクトデータ

#### SourceAudio

| フィールド | 型 | 内容 |
|---|---|---|
| `absolutePath` | string | 保存時の絶対パス |
| `relativePath` | string | プロジェクトファイル基準の相対パス |
| `sha256` | string | 音源識別 |
| `durationSec` | number | 音源長 |
| `sampleRate` | number | 元サンプルレート |
| `channels` | number | 元チャンネル数 |

プロジェクト読込時は相対パス、絶対パス、SHA-256照合の順で音源を解決する。解決画面ではユーザーが音源を再指定できる。

#### Tempo

```json
{
  "bpm": 120.0,
  "timeSignature": {
    "numerator": 4,
    "denominator": 4
  },
  "ppq": 480,
  "quantizeGrid": "1/16"
}
```

#### Track

```json
{
  "id": "uuid",
  "displayName": "Electric Bass",
  "instrumentId": "electric_bass",
  "kind": "pitched",
  "color": "#7A5AF8",
  "order": 2,
  "midiChannel": 1,
  "gmProgram": 33,
  "mute": false,
  "solo": false
}
```

#### Note

```json
{
  "id": "uuid",
  "sourceInstrumentId": "distorted_electric_guitar",
  "trackId": "uuid",
  "pitch": 64,
  "rawStartSec": 12.345,
  "rawEndSec": 12.890,
  "startSec": 12.345,
  "endSec": 12.890,
  "velocity": 100
}
```

#### Transcription

| フィールド | 内容 |
|---|---|
| `mode` | `direct` / `four_stem` |
| `presetId` | 使用プリセットID |
| `modelProfileId` | 使用モデルプロファイルID |
| `modelSha256` | モデル識別 |
| `backend` | CPU / CUDA |
| `completedAt` | 完了時刻 |

#### Stem

| フィールド | 内容 |
|---|---|
| `type` | drums / bass / vocals / other |
| `cachePath` | プロジェクトキャッシュ内のパス |
| `sha256` | ステム識別 |
| `sampleRate` | 44100 |
| `channels` | 2 |

### 12.3 保存動作

プロジェクト保存時は、現在のトラック、ノート、BPM、拍子、Mute／Solo、表示タブ、ズーム、スクロール位置、処理情報を1つのスナップショットとして書き込む。

プロジェクト読込時は採譜済みノートから編集画面とSoundFontスケジュールを再構築する。

---

## 13. SMF出力

### 13.1 出力仕様

| 項目 | 仕様 |
|---|---|
| ファイル形式 | Standard MIDI File Format 1 |
| 拡張子 | `.mid` |
| PPQ | 480 |
| Tempo | プロジェクトBPM |
| Time Signature | プロジェクト拍子 |
| Track 0 | Tempo、Time Signature、曲名 |
| 音程トラック | 1パートにつき1 MIDIトラック |
| ドラム | MIDIチャンネル10 |
| Program Change | tick 0に出力 |
| Track Name | 出力パート名 |
| Velocity | ノートの`velocity`、初期値100 |

### 13.2 チャンネル割り当て

音程トラックをプリセット順に次のチャンネルへ割り当てる。

```text
1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16
```

ドラムトラックへチャンネル10を割り当てる。

### 13.3 ノートイベント

`startSec`と`endSec`を現在のBPMでtickへ変換し、同一tickでは次の順でイベントを配置する。

1. Note Off
2. Program Changeおよび制御イベント
3. Note On

これにより、連続する同音ノートの境界を明確にする。

---

## 14. MusicXML出力

### 14.1 出力仕様

| 項目 | 仕様 |
|---|---|
| バージョン | MusicXML 4.0 |
| 形式 | partwise |
| 拡張子 | `.musicxml` |
| divisions | 480 |
| テンポ | 固定BPM |
| 拍子 | プロジェクト拍子 |
| 調号 | fifths = 0 |
| パート | ノートを含むトラックごとに1パート |
| 音高 | コンサートピッチ |
| レイアウト | MuseScore側で自動整形可能な構造 |

### 14.2 小節生成

1. ノート時刻をPPQ 480のtickへ変換する。
2. プロジェクトの拍位置とクオンタイズ設定で譜面用tickへ補正する。
3. 拍子から小節長を算出する。
4. 最後のノートを含む小節まで生成し、音源末尾の無音区間は生成しない。
5. ノートを小節へ分配する。
6. 小節境界をまたぐノートを分割し、tie start／stopを付加する。
7. 同一開始tickのノートをコードとしてまとめる。
8. 重なり合うノートを貪欲法でvoiceへ分配する。
9. 各小節で使用するvoiceだけに休符を生成する。
10. 空小節は1個の完全小節休符として出力する。

MIDIは演奏タイミングを保持する形式であり、MusicXMLは可読性を優先する譜面形式で
ある。MusicXML書き出し時のクオンタイズはMIDI書き出しやプロジェクト内のノートを
変更しない。

### 14.3 音部記号

| 楽器 | 音部記号 |
|---|---|
| Viola | Alto clef |
| Cello、Contrabass、Electric Bass、Acoustic Bass、Bassoon、Tuba、Baritone Sax | Bass clef |
| Drums | Percussion clef |
| その他 | Treble clef |

### 14.4 ドラム譜

ドラムパートは`unpitched`要素とMusicXML instrument定義を使用し、GM Percussionノート番号をdisplay-step、display-octave、noteheadへ変換する。バスドラム、スネア、ハイハット、タム、シンバルを一般的な5線ドラム譜位置へ割り当てる。

---

## 15. 分離ステムWAV出力

4ステム前処理付きプロジェクトでは、次のファイルを書き出す。

```text
<曲名>_drums.wav
<曲名>_bass.wav
<曲名>_vocals.wav
<曲名>_other.wav
```

| 項目 | 仕様 |
|---|---|
| サンプルレート | 44.1 kHz |
| チャンネル | Stereo |
| 量子化 | 24-bit PCM |
| 長さ | 元音源と同一 |
| 基準レベル | 分離エンジン出力ゲインを維持 |

編集画面の「分離WAVを保存」で保存先フォルダーを選択する。書き出し完了後は
エクスプローラーを開き、先頭の分離WAVを選択状態で表示する。

---

## 16. フロントエンド内部設計

### 16.1 主要コンポーネント

| コンポーネント | 責務 |
|---|---|
| `ProjectStore` | プロジェクト全体の編集状態 |
| `TrackList` | 色、名称、Mute、Solo |
| `PianoRollCanvas` | 音程パートの描画と選択 |
| `DrumRollCanvas` | ドラムレーンの描画 |
| `SelectionController` | クリック、Shift追加、矩形選択 |
| `PartAssignmentMenu` | 選択ノートのパート移動 |
| `QuantizeController` | 全ノートのtick丸め |
| `TransportBar` | 再生、停止、A/B切替、時刻表示 |
| `PlaybackController` | 原音クロックとSoundFont同期 |
| `PresetEditor` | 最大16トラックの編成編集 |
| `ExportDialog` | SMF、MusicXML、ステムWAVの保存先指定 |

### 16.2 描画データ構造

ノートはトラックごとに開始時刻順の配列で保持する。表示範囲探索には二分探索を使用し、現在の時間範囲と交差するノートだけをCanvasへ描画する。

ヒットテスト用に次のキーを持つインデックスを作成する。

```text
時間区間
MIDIノート番号またはドラムレーン
トラックID
ノートID
```

矩形選択は表示範囲候補を時間で絞り、音高範囲またはドラムレーン範囲との交差判定を行う。

### 16.3 Electron連携

RendererからPreload APIを経由して次の処理を呼び出す。

```typescript
interface DesktopApi {
  selectAudioFile(): Promise<string | null>;
  selectModelFile(): Promise<string | null>;
  openProjectFile(): Promise<string | null>;
  saveProjectFile(defaultName: string, json: string): Promise<string | null>;
  selectExportPath(kind: "midi" | "musicxml" | "stems"): Promise<string | null>;
  listAudioOutputDevices(): Promise<AudioDevice[]>;
  revealInExplorer(path: string): Promise<void>;
}
```

---

## 17. ローカルAPI

Pythonサービスは`127.0.0.1`の動的ポートで起動し、Electronが生成したセッショントークンでアクセスを認証する。

### 17.1 エンドポイント

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/v1/health` | 起動確認、バージョン取得 |
| GET | `/api/v1/instruments` | MuScriptor楽器グループ一覧 |
| POST | `/api/v1/models/validate` | ローカルモデル検証 |
| POST | `/api/v1/audio/inspect` | 音源情報取得 |
| POST | `/api/v1/tempo/estimate` | BPM推定 |
| POST | `/api/v1/jobs/transcribe` | 採譜ジョブ開始 |
| GET | `/api/v1/jobs/{jobId}/events` | SSE進捗・ノートイベント |
| POST | `/api/v1/jobs/{jobId}/cancel` | ジョブ停止 |
| POST | `/api/v1/export/midi` | SMF生成 |
| POST | `/api/v1/export/musicxml` | MusicXML生成 |
| POST | `/api/v1/export/stems` | ステムWAV生成 |

### 17.2 採譜イベント

```json
{
  "type": "note",
  "eventIndex": 123,
  "instrumentId": "violin",
  "pitch": 72,
  "startSec": 10.25,
  "endSec": 10.88
}
```

```json
{
  "type": "progress",
  "stage": "transcribing",
  "completed": 48,
  "total": 120
}
```

---

## 18. Windowsフォルダ配布構成

### 18.1 論理構成

```text
EarCopyAssist/
├─ EarCopyAssist.exe
├─ resources/
│  ├─ app.asar
│  ├─ backend/
│  ├─ models/scnet/
│  ├─ soundfonts/
│  └─ licenses/
├─ models/
│  └─ muscriptor/
└─ UserData/
   ├─ model-profiles.json
   ├─ presets.json
   └─ cache/
```

配布フォルダにはElectronアプリ、Pythonローカルサービス、CPU／CUDA推論ランタイム、
SoundFont、ライセンス表示用文書を収録する。利用者はフォルダ内の
`EarCopyAssist.exe`を起動する。MuScriptorモデルは利用者が
`models/muscriptor/`へ配置する。

### 18.2 配布物

| 配布物 | 内容 |
|---|---|
| `EarCopyAssist/` | CPU／NVIDIA CUDA推論に対応するWindows配布フォルダ一式 |
| `EarCopyAssist.exe` | アプリの起動ファイル |

ユーザーはライセンス同意済みのMuScriptorモデルを`models/muscriptor/`へ配置し、モデル設定画面で登録する。

---

## 19. 性能設計

### 19.1 長時間音源

- 元音源はファイルストリーミングで再生する。
- MuScriptorのイベントはチャンク単位で受信する。
- ピアノロールは可視範囲のノートを描画する。
- SoundFontスケジューラは100 msの先読み範囲を処理する。
- 音源変換、BPM解析、音源分離は一時ファイルを共有する。
- プロジェクト保存はノート配列を開始時刻順に出力する。

### 19.2 メモリ管理

- モデルロードとアンロードをバックエンド単位で管理する。
- 音源キャッシュはプロジェクトID別ディレクトリへ保存する。
- キャッシュ管理画面で使用量、最終使用日時、削除対象を表示する。
- SoundFontのサンプルデコードは使用音高単位でプリウォームする。

### 19.3 UI応答性

- 採譜、音源分離、BPM推定、書き出しはPythonサービスで実行する。
- Canvas描画はrequestAnimationFrameで更新する。
- ノート選択、パート移動、Mute／SoloはRenderer内で即時反映する。
- 大量ノート更新はトラック単位の差分として描画キャッシュへ反映する。

---

## 20. エラー処理とログ

| 事象 | 画面動作 |
|---|---|
| モデルファイル検証エラー | ファイル名、検証項目、詳細ログを表示 |
| モデルロードエラー | バックエンド、dtype、デバイス情報を表示 |
| GPUメモリエラー | 使用モデル、推論バックエンド、処理位置を表示 |
| 音源変換エラー | 入力形式、FFmpeg結果、ログ参照先を表示 |
| 採譜エラー | 完了チャンク数と例外情報を表示 |
| プロジェクト読込エラー | formatVersion、対象フィールド、復元可能情報を表示 |
| 書き出しエラー | 出力形式、保存先、原因を表示 |

ログは`UserData/logs/app.log`へ日次ローテーションで保存する。各処理には`projectId`と`jobId`を付与する。

---

## 21. ライセンス表示

ライセンス画面と`licenses/`へ次の情報を収録する。

| 対象 | 表示内容 |
|---|---|
| アプリ本体 | 配布ライセンス、著作権表示 |
| MuScriptorコード | MIT License |
| MuScriptorモデル | CC BY-NC 4.0、モデル名、モデルハッシュ |
| MuseScore General SoundFont | MIT License |
| SCNet Large | MIT License、モデル名、モデルハッシュ |
| Electron / React / Python依存物 | Third-Party Notices |
| FFmpeg | 使用ビルドのライセンス情報 |

About画面には、現在登録中のMuScriptorモデル名、SHA-256、ライセンス区分、採譜エンジンバージョンを表示する。

---

## 22. 開発フェーズ

### Phase 1：MuScriptor接続とプロジェクト基盤

- ローカル`.safetensors`登録
- CPU推論
- 音源読み込み
- BPM自動推定と手動修正
- プリセット選択
- MuScriptorイベントの共通ノート形式への変換
- `.ecaproj`保存・読込
- SMF Format 1出力

### Phase 2：デスクトップ編集画面

- ElectronポータブルEXE
- 統合ピアノロール
- ドラムロール
- クリック、Shift追加、矩形選択
- 選択ノートのパート移動
- 同一ノート上書き
- 全体クオンタイズ
- Mute／Solo
- 水平・垂直ズームとスクロール

### Phase 3：比較再生とCUDA

- MuseScore General SF3再生
- 原音／採譜結果A/B切替
- 同期再生、シーク、再生カーソル
- Windows出力デバイス選択
- CUDA推論
- 長時間音源向け可視範囲描画と先読みスケジューラ

### Phase 4：MusicXML

- MusicXML 4.0 partwise出力
- 小節、休符、コード、voice、tie
- 楽器別音部記号
- ドラム譜変換
- MuseScore読込試験

### Phase 5：4ステム音源分離

- SCNet Largeバックエンド
- drums / bass / vocals / other分離
- ステム別MuScriptor採譜
- ノート統合
- 4ステムWAV出力

---

## 23. 受入試験

### 23.1 採譜

- 登録済みローカルモデルから採譜を開始できる。
- プリセットの楽器グループがMuScriptor制約へ反映される。
- NoteStart／NoteEndイベントが1つのノートへ結合される。
- 音程パートとドラムパートへ正しく振り分けられる。

### 23.2 編集

- クリック、Shift追加、矩形選択で対象ノートを選択できる。
- 複数トラックにまたがる選択ノートを1つのパートへ移動できる。
- 同一ノート判定時に移動ノートが採用される。
- 全ノートの開始・終了時刻へ指定グリッドが適用される。
- 保存後の再読込でノート位置、所属パート、BPM、拍子が一致する。

### 23.3 再生

- 原音と採譜結果が同じ再生位置から開始する。
- 再生中のA/B切替で再生位置が維持される。
- シーク後に原音、SoundFont、再生カーソルが同じ位置へ移動する。
- Mute／SoloがSoundFont再生へ即時反映される。
- 指定したWindowsオーディオデバイスから出力される。

### 23.4 出力

- SMFをMuseScoreで開き、トラック名、テンポ、拍子、Program、ドラムチャンネルが反映される。
- MusicXMLをMuseScoreで開き、パート、小節、休符、タイ、コード、音部記号が反映される。
- 4ステムWAVの長さ、サンプルレート、チャンネル数が仕様値と一致する。

### 23.5 性能

- 100,000ノート規模のプロジェクトでスクロールとズームが継続動作する。
- 30分以上の音源で原音再生がストリーミング動作する。
- 採譜進捗がチャンク単位で更新される。
- CPU版とCUDA版で同じプロジェクト形式を読み書きできる。

---

## 24. 参照仕様

本設計は、MuScriptor公式リポジトリの2026年7月26日時点のREADME、PythonイベントAPI、Web UI、楽器グループ定義、GM Program対応表を基準とする。MuScriptorはローカル`.safetensors`をモデル入力として受け取り、指定楽器グループを採譜制約へ使用し、NoteStart／NoteEnd／Progressイベントをストリーミング出力する。

音源分離はSCNet Largeの4ステム構成であるdrums、bass、vocals、otherを基準とする。
