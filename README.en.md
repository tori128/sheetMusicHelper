# EarCopy Assist

[日本語](README.md)

![main](docs\assets\main.png)

EarCopy Assist is a Windows application that transcribes instrument parts from audio and provides tools to review, edit, save, and export the result.
Its transcription workflow can use source separation to improve accuracy.



## Requirements

- 64-bit Windows 10 or Windows 11
- BS-RoFormer SW Fixed when transcribing after source separation
- A compatible NVIDIA GPU and driver when using CUDA

Transcription can run on the CPU when an NVIDIA GPU is unavailable.



## Features

- **Transcription**: Choose direct transcription or transcription after source separation.
- **Instrument selection**: Choose an ensemble preset for output-track candidates or let the model detect instruments automatically.
- **Review and editing**: Preview, add, erase by range, move, resize, reassign, undo, and redo notes.
- **Beat-based editing**: Display measures and beats from the estimated tempo and time signature, quantize notes, and set the beat position.
- **Chord display**: Estimate chord names from the transcription.
- **Difference from source**: Display a color-coded difference value for each beat.
- **Playback review**: Switch between source audio and transcription, compare them on the left and right channels, and use Mute, Solo, and the metronome.
- **Display language**: Select Japanese, English, or Chinese.
- **Save and export**: Save `*.ecaproj` projects, MIDI, MusicXML, and separated WAV files.



## Documentation

- [User Guide](docs/USER_GUIDE.en.md) / [使い方](docs/USER_GUIDE.md)
- [Performance Evaluation](docs/TRANSCRIPTION_METHOD_BENCHMARK.en.md) / [性能評価](docs/TRANSCRIPTION_METHOD_BENCHMARK.md)
- [Public Tempo, Beat, and Downbeat Evaluation](docs/developer/TEMPO_DOWNBEAT_EVALUATION.en.md) / [テンポ・拍・小節先頭推定の公開評価](docs/developer/TEMPO_DOWNBEAT_EVALUATION.md)
- [Development Guide](docs/developer/DEVELOPMENT.en.md) / [開発ガイド](docs/developer/DEVELOPMENT.md)
- [Release and Distribution Checklist](docs/developer/DISTRIBUTION.en.md) / [公開・配布チェックリスト](docs/developer/DISTRIBUTION.md)



## License

EarCopy Assist itself is provided under the [MIT License](LICENSE).
External software, playback sounds, and AI models remain subject to their respective licenses and terms.
Official MuScriptor models are restricted to non-commercial use under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) and additional terms on each distribution page.
See [Terms and sources for external software and models](THIRD_PARTY_NOTICES.en.md) for details.
