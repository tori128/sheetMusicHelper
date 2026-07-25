from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx
from mido import MidiFile


def tempo_fixture(value: str) -> tuple[float, Path]:
    expected_text, separator, path_text = value.partition("=")
    if not separator or not path_text:
        raise argparse.ArgumentTypeError("期待BPM=Waveパス の形式で指定してください")
    try:
        expected_bpm = float(expected_text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("期待BPMは数値で指定してください") from exc
    if not 20 <= expected_bpm <= 300:
        raise argparse.ArgumentTypeError("期待BPMは20～300で指定してください")
    return expected_bpm, Path(path_text).resolve()


def free_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def write_click_track(path: Path, duration_sec: float = 6.0) -> None:
    sample_rate = 44_100
    sample_count = int(sample_rate * duration_sec)
    beat_offset_samples = int(sample_rate * 0.2)
    frames = bytearray()
    for index in range(sample_count):
        if index < beat_offset_samples:
            frames.extend(struct.pack("<h", 0))
            continue
        within_beat = (index - beat_offset_samples) % (sample_rate // 2)
        envelope = max(0.0, 1.0 - within_beat / (sample_rate * 0.04))
        sample = int(
            16_000
            * envelope
            * math.sin(2 * math.pi * 880 * index / sample_rate)
        )
        frames.extend(struct.pack("<h", sample))
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(frames)


def convert_to_mp3(source: Path, destination: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("受入試験用MP3生成にffmpegが必要です")
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-i",
            str(source),
            "-codec:a",
            "libmp3lame",
            str(destination),
        ],
        check=True,
        capture_output=True,
    )


def wait_for_health(client: httpx.Client, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"backend exited early: {process.returncode}")
        try:
            if client.get("/api/v1/health").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise TimeoutError("packaged backend health check timed out")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="配布用バックエンドのブラックボックス受入試験"
    )
    parser.add_argument("--backend", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument(
        "--scnet-model",
        type=Path,
        default=Path("models/scnet/large"),
    )
    parser.add_argument(
        "--tempo-fixture",
        type=tempo_fixture,
        action="append",
        default=[],
        metavar="EXPECTED=PATH",
    )
    args = parser.parse_args()
    backend = args.backend.resolve()
    model = args.model.resolve()
    scnet_model = args.scnet_model.resolve()
    if not backend.is_file() or not model.is_file() or not scnet_model.is_dir():
        raise SystemExit("backendまたはmodelが見つかりません")
    missing_tempo_fixtures = [
        path for _, path in args.tempo_fixture if not path.is_file()
    ]
    if missing_tempo_fixtures:
        raise SystemExit(
            f"テンポ試験Waveが見つかりません: {missing_tempo_fixtures[0]}"
        )

    port = free_port()
    token = uuid4().hex
    with tempfile.TemporaryDirectory(prefix="earcopy-acceptance-") as temporary:
        root = Path(temporary)
        wav_path = root / "click.wav"
        audio_path = root / "click.mp3"
        midi_path = root / "acceptance.mid"
        musicxml_path = root / "acceptance.musicxml"
        stems_output = root / "exported-stems"
        project_path = root / "acceptance.ecaproj"
        write_click_track(wav_path)
        convert_to_mp3(wav_path, audio_path)
        environment = {
            **os.environ,
            "EARCOPY_SESSION_TOKEN": token,
            "EARCOPY_USER_DATA": str(root / "UserData"),
            "EARCOPY_MODELS_DIRS": str(model.parent.parent),
            "EARCOPY_SCNET_MODEL_DIR": str(scnet_model),
            # 外部FFmpegを誤って使わず、配布物の同梱ツールだけを検証する。
            "PATH": str(Path(os.environ["SystemRoot"]) / "System32"),
        }
        creationflags = (
            subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        )
        process = subprocess.Popen(
            [str(backend), "--port", str(port)],
            cwd=backend.parent,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
        )
        try:
            with httpx.Client(
                base_url=f"http://127.0.0.1:{port}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=180,
            ) as client:
                wait_for_health(client, process)
                instruments = client.get("/api/v1/instruments").raise_for_status().json()
                presets = client.get("/api/v1/presets").raise_for_status().json()
                profiles = client.get("/api/v1/models").raise_for_status().json()
                assert any(item["id"] == "drums" for item in instruments)
                assert len(presets) == 5
                user_preset = (
                    client.post(
                        "/api/v1/presets",
                        json={
                            "name": "Acceptance Preset",
                            "tracks": [
                                {
                                    "displayName": "Piano",
                                    "instrumentId": "acoustic_piano",
                                    "color": "#4C9AFF",
                                    "kind": "pitched",
                                    "order": 1,
                                }
                            ],
                        },
                    )
                    .raise_for_status()
                    .json()
                )
                assert user_preset["key"].startswith("user:")
                assert len(
                    client.get("/api/v1/presets").raise_for_status().json()
                ) == 6
                profile = next(
                    item
                    for item in profiles
                    if Path(item["modelPath"]).resolve() == model
                )

                audio = (
                    client.post(
                        "/api/v1/audio/inspect", json={"path": str(audio_path)}
                    )
                    .raise_for_status()
                    .json()
                )
                tempo = (
                    client.post(
                        "/api/v1/tempo/estimate", json={"path": str(audio_path)}
                    )
                    .raise_for_status()
                    .json()
                )
                assert audio["sampleRate"] == 44_100
                assert audio["codecName"] == "mp3"
                assert 20 <= tempo["bpm"] <= 300
                assert abs(tempo["beatOffsetSec"] - 0.2) < 0.1
                fixture_tempos = {}
                for expected_bpm, fixture_path in args.tempo_fixture:
                    fixture_tempo = (
                        client.post(
                            "/api/v1/tempo/estimate",
                            json={"path": str(fixture_path)},
                        )
                        .raise_for_status()
                        .json()
                    )
                    actual_bpm = fixture_tempo["bpm"]
                    assert abs(actual_bpm - expected_bpm) <= 0.6, (
                        fixture_path,
                        expected_bpm,
                        actual_bpm,
                    )
                    fixture_tempos[fixture_path.name] = actual_bpm

                track_id = str(uuid4())
                track = {
                    "id": track_id,
                    "displayName": "Piano",
                    "instrumentId": "acoustic_piano",
                    "kind": "pitched",
                    "color": "#4C9AFF",
                    "order": 1,
                    "midiChannel": 1,
                    "gmProgram": 0,
                    "mute": False,
                    "solo": False,
                }
                job_id = (
                    client.post(
                        "/api/v1/jobs/transcribe",
                        json={
                            "audioPath": str(audio_path),
                            "modelPath": str(model),
                            "dtype": "float32",
                            "mode": "four_stem",
                            "tracks": [track],
                        },
                    )
                    .raise_for_status()
                    .json()["jobId"]
                )
                events: list[dict] = []
                with client.stream(
                    "GET", f"/api/v1/jobs/{job_id}/events"
                ) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if line.startswith("data:"):
                            events.append(json.loads(line[5:].strip()))
                states = [
                    event["status"]
                    for event in events
                    if event["type"] == "state"
                ]
                assert states[-1] == "completed", events
                assert "separating" in states
                assert any(event["type"] == "progress" for event in events)
                stem_events = [
                    event["stem"]
                    for event in events
                    if event["type"] == "stem"
                ]
                assert {stem["type"] for stem in stem_events} == {
                    "drums",
                    "bass",
                    "vocals",
                    "other",
                }

                note = {
                    "id": str(uuid4()),
                    "sourceInstrumentId": "acoustic_piano",
                    "trackId": track_id,
                    "pitch": 60,
                    "rawStartSec": 0.5,
                    "rawEndSec": 1.0,
                    "startSec": 0.5,
                    "endSec": 1.0,
                    "velocity": 100,
                }
                project = {
                    "formatVersion": 1,
                    "appVersion": "0.1.0",
                    "projectId": str(uuid4()),
                    "name": "Acceptance",
                    "sourceAudio": {
                        "absolutePath": str(audio_path),
                        "relativePath": "",
                        "sha256": audio["sha256"],
                        "durationSec": audio["durationSec"],
                        "sampleRate": audio["sampleRate"],
                        "channels": audio["channels"],
                    },
                    "tempo": {
                        "bpm": tempo["bpm"],
                        "beatOffsetSec": tempo["beatOffsetSec"],
                        "timeSignature": {"numerator": 4, "denominator": 4},
                        "ppq": 480,
                        "quantizeGrid": "1/16",
                    },
                    "transcription": {
                        "mode": "four_stem",
                        "presetId": str(uuid4()),
                        "modelProfileId": profile["id"],
                        "modelSha256": profile["sha256"],
                        "backend": "CPU",
                        "completedAt": "2026-07-26T00:00:00Z",
                    },
                    "tracks": [track],
                    "notes": [note],
                    "stems": stem_events,
                    "viewState": {
                        "activeRoll": "pitched",
                        "horizontalZoom": 1,
                        "verticalZoom": 1,
                        "scrollTimeSec": 0,
                    },
                }
                client.post(
                    "/api/v1/export/midi",
                    json={"project": project, "outputPath": str(midi_path)},
                ).raise_for_status()
                midi = MidiFile(midi_path)
                assert midi.type == 1 and midi.ticks_per_beat == 480
                assert any(
                    message.type == "note_on"
                    for midi_track in midi.tracks
                    for message in midi_track
                )
                client.post(
                    "/api/v1/export/musicxml",
                    json={
                        "project": project,
                        "outputPath": str(musicxml_path),
                    },
                ).raise_for_status()
                musicxml = ET.parse(musicxml_path).getroot()
                assert musicxml.tag == "score-partwise"
                assert musicxml.attrib["version"] == "4.0"
                assert musicxml.findtext("part/measure/attributes/divisions") == "480"
                assert musicxml.find("part/measure/note/pitch") is not None
                exported_stems = (
                    client.post(
                        "/api/v1/export/stems",
                        json={
                            "project": project,
                            "outputDirectory": str(stems_output),
                        },
                    )
                    .raise_for_status()
                    .json()["paths"]
                )
                assert len(exported_stems) == 4
                for stem_path in exported_stems:
                    with wave.open(stem_path, "rb") as stem_audio:
                        assert stem_audio.getframerate() == 44_100
                        assert stem_audio.getnchannels() == 2
                        assert stem_audio.getsampwidth() == 3

                project_path.write_text(
                    json.dumps(project, ensure_ascii=False), encoding="utf-8"
                )
                loaded = (
                    client.post(
                        "/api/v1/projects/load",
                        json={"path": str(project_path)},
                    )
                    .raise_for_status()
                    .json()
                )
                assert loaded["notes"] == project["notes"]
                assert loaded["tempo"] == project["tempo"]
                print(
                    json.dumps(
                        {
                            "health": "ok",
                            "modelVariant": profile["variant"],
                            "estimatedBpm": tempo["bpm"],
                            "fixtureBpms": fixture_tempos,
                            "beatOffsetSec": tempo["beatOffsetSec"],
                            "sourceFormat": audio["codecName"],
                            "transcriptionStates": states,
                            "eventCount": len(events),
                            "midiTracks": len(midi.tracks),
                            "musicXmlParts": len(musicxml.findall("part")),
                            "stemFiles": len(exported_stems),
                            "userPresetRoundTrip": True,
                            "projectRoundTrip": True,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        [
                            "taskkill.exe",
                            "/pid",
                            str(process.pid),
                            "/T",
                            "/F",
                        ],
                        check=False,
                        capture_output=True,
                    )
                else:
                    process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
