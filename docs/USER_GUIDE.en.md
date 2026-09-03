# EarCopy Assist User Guide

[日本語](USER_GUIDE.md)

## Download

Download the Windows version from [GitHub Releases](https://github.com/tori128/sheetMusicHelper/releases).
Download all of the following files from the release:

- `EarCopyAssist-<version>-win-x64.zip`
- `EarCopyAssist-<version>-win-x64.z01, .z02, ...`
- `EarCopyAssist-<version>-muscriptor-small.zip`
- `EarCopyAssist-<version>-muscriptor-medium.zip`
- `EarCopyAssist-<version>-muscriptor-large.zip` and `.z01, .z02, ...`

Use an extraction tool that supports split ZIP archives, such as [7-Zip](https://www.7-zip.org/).



## Installation

1. Put every Windows `.z01` and later volume with the final `.zip` in one folder, then open the final `.zip`.
2. Extract the MuScriptor small, medium, and large archives into the parent folder of the extracted Windows package. This creates `EarCopyAssist-<version>-win-x64\\models\\muscriptor\\small`, `medium`, and `large`.
3. Launch `EarCopyAssist.exe` in the extracted Windows-package folder and review the MuScriptor model terms. MuScriptor small, medium, and large model weights are restricted to non-commercial use.

Select Japanese, English, or Chinese from the language control at the top of the new-project screen or in **設定 (Settings)**.



## Usage

### Transcribe audio

1. Select a WAV, MP3, FLAC, Ogg, M4A, or AAC file with **音源ファイルを選択 (Select audio file)**.
2. Choose the project name, instrument-selection method, MuScriptor model, processing mode, transcription mode, inference backend, and time signature.
3. Select **採譜を開始 (Start transcription)**.

The application estimates the BPM and first measure position when an audio file is selected.
Completed results appear while transcription continues.

| Setting | Recommended | Choices |
|---|---|---|
| Instrument selection | **編成プリセット (Ensemble preset)** | **編成プリセット** uses the specified instrument group as transcription candidates. **自動推定 (Automatic detection)** detects instruments and creates up to 16 tracks. |
| Processing mode | **音源分離してから採譜 (Transcribe after source separation)** | **直接採譜 (Direct transcription)** transcribes the source audio. **音源分離してから採譜** transcribes separated components individually and combines the results. |
| Transcription mode | **高精度 (High accuracy)** | **高速 (Fast)** processes multiple sections in parallel on a GPU, but notes or instrument recognition can change at section boundaries. |
| Inference backend | `Auto` | `Auto` prefers CUDA and uses the CPU when CUDA is unavailable. |

#### Transcribe after source separation

The application separates the source into drums, bass, vocals, piano, guitar, and other.
Each component can be selected on the playback screen, and **分離WAV (Separated WAV)** saves the six components as individual WAV files.
When BS-RoFormer SW Fixed is unavailable, select **警告を確認してダウンロード (Review warning and download)** to let the application obtain the model.
The model distribution page does not specify license terms for the weight; review the displayed `Unknown` license status before using it.

##### Download the source-separation model

The BS-RoFormer SW Fixed model weight is not included with the application. When it is unavailable, the new-project screen displays **音源分離モデルがありません (Source-separation model is unavailable)**.
Confirm that you have the right to obtain and use the model because its distribution page does not state license terms for the weight.

1. Select **警告を確認してダウンロード (Review warning and download)** on the new-project screen.
2. Review the warning and distribution page.
3. Select the license acknowledgement.
4. Select **警告を確認してダウンロード** in the dialog.

After the download completes, **音源分離してから採譜 (Transcribe after source separation)** becomes available.

##### Use another BS-RoFormer weight

Place one other BS-RoFormer weight in `models\\bs-roformer\\sw-fixed` with the YAML configuration file for that weight. The YAML `training.instruments` list must contain the component names produced by the model from `drums`, `bass`, `vocals`, `other`, `piano`, and `guitar`.

##### Available options

| Setting | Recommended default | Effect |
|---|---|---|
| **音源分離後の発音開始時刻の誤差を低減する (Reduce onset-time errors after source separation)** | ON | Adds the drums waveform to Bass, Piano, Guitar, Vocal, and Other before transcription to reduce onset-position errors. |
| **分離後音源の音量からベロシティを設定する (Set velocity from separated-audio level)** | ON | Measures the level near each onset and applies it to the transcription velocity. |
| **ドラム成分の追加による音高の誤検出を削減する (Reduce pitch false positives caused by added drums)** | ON | When onset-time error reduction is enabled, uses transcription without the drums component to correct the result. |

The first option is available on the new-project screen. Change the other options under **採譜オプション (Transcription options)** after transcription.

---

## Review and edit

### Zoom and scroll

- Mouse wheel: Scroll horizontally.
- `Ctrl`+wheel: Zoom the time axis horizontally.
- `Shift`+wheel: Zoom the pitch axis vertically.

### Playback

Press `Space` to play or pause. Click the playback-position bar or a measure number to seek.

#### Playback modes

![Playback modes](assets/play_mode.png)

| Mode | Output | Mute/Solo state when selected |
|---|---|---|
| **原音 (Source)** | Plays the source audio or separated components. | Enables the source audio and separated components, mutes the transcription, and clears every Solo selection. |
| **採譜結果 (Transcription)** | Plays the transcription. | Enables the transcription, mutes the source audio and separated components, and clears every Solo selection. |
| **左右比較 (L/R comparison)** | Plays the source audio or separated components on the left channel and the transcription on the right channel. | Clears every Mute and Solo selection on both sides. |

#### Mute / Solo

Selecting a mode resets the Mute and Solo states to the values in the table. **M** toggles Mute for the selected transcription track or separated component. **S** selects a transcription track or separated component for Solo, clears its Mute state, and mutes the other items. Multiple transcription tracks or separated components can be selected for Solo.

When Solo is active, a transcription track selected for Solo can also be muted. A separated component selected for Solo can also be muted. In **左右比較 (L/R comparison)** mode with separated components, Mute and Solo change together for a transcription track and its corresponding separated component. Without separated components, transcription-track Mute and Solo affect transcription playback and display while source-audio playback remains active.

The transcription-track list and separated-component list each use these states:

* When one or more items are selected for Solo, every item without Solo is muted.
* Clearing the final Solo selection clears Mute for every item in that list.
* Mute can be toggled manually for an item selected for Solo.

Under **設定 (Settings) > 再生 (Playback)**, select the audio output device and playback-position offset. A positive offset delays the source; a negative offset delays the transcription.

#### Play and display selected parts

Select a transcription track's **S** button to display only the tracks selected for Solo.

#### Repeat playback

**全体 (All)** repeats the complete playback range.
For A-B repeat, select the start position and set **A**, select the end position and set **B**, then enable **A-B**.

### Difference from source audio

Select **不一致度の表示 (Difference display) > 更新 (Update)** to compare the visible transcription with the source audio or selected separated component and color each beat by its difference value.
A higher difference is displayed closer to red, and a lower difference is displayed closer to green.
The value includes timbre differences between the recording and SoundFont playback, so a high value does not by itself prove that the transcription is incorrect.

![Difference display](assets/diff_origin.png)

### Note editing

Select the operation grid under **分解能 (Resolution)** on the Edit tab.

| Action | Result |
|---|---|
| Click a note, `Shift`+click, or drag over empty space | Select a note, add it to the selection, or select a range. |
| Drag a note body or press `←` / `→` | Move the note in time. |
| Drag a pitched note vertically or press `↑` / `↓` | Transpose by a semitone. Add `Shift` to transpose by an octave. |
| Drag the left or right edge | Change the start or end position. |
| Click or drag empty space with the Draw tool | Add a note. Existing notes use the Select-tool operations. |
| Click or drag a range with the Erase tool, or press `Delete` / `Backspace` | Delete notes. |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy, cut, or paste selected notes at the playback position. |
| `Ctrl+Z` / `Ctrl+Y` | Undo or redo an edit. |
| **再生位置で分割 (Split at playback position)** / **隣接ノートを結合 (Join adjacent notes)** | Split or join selected notes. |
| **選択ノートの音価をグリッドに合わせる (Set selected note duration to grid)** | Change selected notes to the duration specified by **分解能**. |
| Select a destination under **ノートの移動 (Move notes)** and press **移動 (Move)** | Change the output track of selected notes. Pitched notes can move to pitched tracks, and drum notes can move to drum tracks. |
| **小節先頭に設定 (Set as measure start)** | Select one note and move the measure and beat lines so its start becomes the beginning of a measure. |
| **拍位置にフィット (Fit to beat positions)** | Move every note start and end to the nearest grid position at the current resolution. |

If the destination track contains a note with the same pitch and start position, the note with the later end position remains.

The Edit tab can also move all notes together.

Tempo, beat-position, quantization, note-position, pitch, and duration changes become available after transcription completes.
Note addition, deletion, output-track changes, playback, Mute, and Solo remain available during transcription.

#### Example: Set the beginning of the song as a measure start

1. Select the note that should begin the measure and press **小節先頭に設定 (Set as measure start)**.

   ![Before setting the measure start](assets/move_before.png)

2. The measure and beat lines move so the selected note begins a measure.

   ![After setting the measure start](assets/move_after.png)

#### Example: Quantize note starts and durations

1. Select **分解能 (Resolution)** to choose the shortest note duration used by quantization.
2. Press **拍位置にフィット (Fit to beat positions)** to move every note start and end to the selected resolution.

   ![Quantized notes](assets/quant_after.png)

Set the correct measure start before quantization so the beat lines match the song.

#### Example: Move selected notes to another instrument track

1. Click or range-select the notes to move.
2. Select the destination track and press **移動 (Move)**.

   ![Before moving notes](assets/part_move_before.png)

3. The selected notes move to the destination track.

   ![After moving notes](assets/part_move_after.png)


## Save and export

| Output | Content |
|---|---|
| `.ecaproj` | Saves the editing state and notes for each transcription input. |
| MIDI Format 1 | Exports the note start and end positions shown in the editor. |
| MusicXML 4.0 | Exports the transcription as notation data. |
| Separated WAV | Exports drums, bass, vocals, piano, guitar, and other. |

### MusicXML export

Open **書き出し (Export) > MusicXML** to set note resolution, work information, key signature, pickup measure, and notation.
The preview, validation, and MusicXML use note starts and ends quantized to **音符の分解能 (Note resolution)**.
MusicXML becomes available when validation reports zero errors.

### MIDI export

MIDI uses the note start and end positions shown in the editor.



## Data and cache

The application retains the 10 most recently used analysis-audio, separated-audio, and transcription entries and reuses them when the same source is transcribed again.
The `UserData` folder beside `EarCopyAssist.exe` stores the cache.
Use **設定 (Settings) > キャッシュ (Cache)** to view storage use and delete selected entries.



## License

EarCopy Assist itself is licensed under the MIT License. For external software, playback sounds, and AI models, see the bundled `LICENSE.txt`, [Terms and sources for external software and models](../THIRD_PARTY_NOTICES.en.md), and the in-application license viewer.
