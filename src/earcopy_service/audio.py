from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import wave
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .cache_management import mark_cache_entry_used, prune_cache_entries

SUPPORTED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}


class AudioInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    absolute_path: str = Field(alias="absolutePath")
    sha256: str
    duration_sec: float = Field(alias="durationSec")
    sample_rate: int = Field(alias="sampleRate")
    channels: int
    codec_name: str = Field(alias="codecName")


class PlaybackAudioInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    path: str
    sample_rate: int = Field(alias="sampleRate")
    channels: int
    frame_count: int = Field(alias="frameCount")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_media_tool(name: str, override: str | None = None) -> str:
    """配布物へ同梱したFFmpegツールを優先して解決する。"""

    executable_name = f"{name}.exe" if sys.platform == "win32" else name
    if override:
        override_path = Path(override)
        if override_path.is_file():
            return str(override_path)
        resolved_override = shutil.which(override)
        if resolved_override is not None:
            return resolved_override
        raise RuntimeError(f"{name}が見つかりません: {override}")

    bundle_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    bundled = bundle_root / "tools" / executable_name
    if bundled.is_file():
        return str(bundled)
    resolved = shutil.which(name)
    if resolved is None:
        raise RuntimeError(f"{name}が見つかりません")
    return resolved


def _inspect_wave(path: Path) -> tuple[float, int, int, str]:
    with wave.open(str(path), "rb") as source:
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        channels = source.getnchannels()
    return frame_count / sample_rate, sample_rate, channels, "pcm"


def _inspect_with_ffprobe(
    path: Path, ffprobe_executable: str
) -> tuple[float, int, int, str]:
    command = [
        ffprobe_executable,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,duration:format=duration",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "ffprobeが音源を解析できませんでした"
        raise ValueError(detail)
    payload = json.loads(completed.stdout)
    streams = payload.get("streams", [])
    if not streams:
        raise ValueError("音声ストリームが見つかりません")
    stream = streams[0]
    duration_value = stream.get("duration") or payload.get("format", {}).get("duration")
    if duration_value is None:
        raise ValueError("音源の長さを取得できません")
    return (
        float(duration_value),
        int(stream["sample_rate"]),
        int(stream["channels"]),
        str(stream["codec_name"]),
    )


def inspect_audio(
    path: Path, ffprobe_executable: str | None = None
) -> AudioInfo:
    path = path.resolve()
    if not path.is_file():
        raise ValueError("音源ファイルが見つかりません")
    if path.suffix.lower() not in SUPPORTED_AUDIO_EXTENSIONS:
        raise ValueError(f"未対応の音源形式です: {path.suffix}")

    try:
        probe_path = resolve_media_tool("ffprobe", ffprobe_executable)
    except RuntimeError:
        probe_path = None
    if probe_path is not None:
        duration, sample_rate, channels, codec_name = _inspect_with_ffprobe(
            path, probe_path
        )
    elif path.suffix.lower() == ".wav":
        try:
            duration, sample_rate, channels, codec_name = _inspect_wave(path)
        except (wave.Error, EOFError) as exc:
            raise ValueError(f"WAVヘッダーが不正です: {exc}") from exc
    else:
        raise RuntimeError("WAV以外の音源解析にはffprobeが必要です")

    return AudioInfo(
        absolutePath=str(path),
        sha256=sha256_file(path),
        durationSec=duration,
        sampleRate=sample_rate,
        channels=channels,
        codecName=codec_name,
    )


def convert_to_analysis_wav(
    source: Path,
    destination: Path,
    ffmpeg_executable: str | None = None,
) -> Path:
    """44.1kHz stereo 32-bit float WAVを一時ファイル経由で生成する。"""

    executable = resolve_media_tool("ffmpeg", ffmpeg_executable)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        f".{destination.name}.{uuid4().hex}.tmp.wav"
    )
    command = [
        executable,
        "-nostdin",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-c:a",
        "pcm_f32le",
        str(temporary),
    ]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60 * 60,
    )
    if completed.returncode != 0:
        temporary.unlink(missing_ok=True)
        detail = completed.stderr.strip() or "ffmpegによる音源変換に失敗しました"
        raise ValueError(detail)
    temporary.replace(destination)
    return destination


def prepare_analysis_audio(
    source: Path,
    cache_root: Path,
    ffmpeg_executable: str | None = None,
) -> Path:
    """元音源と変換条件から決まる44.1 kHz stereo float WAVを返す。"""

    source = source.resolve()
    if not source.is_file():
        raise ValueError("音源ファイルが見つかりません")
    if source.suffix.lower() not in SUPPORTED_AUDIO_EXTENSIONS:
        raise ValueError(f"未対応の音源形式です: {source.suffix}")
    source_hash = sha256_file(source)
    cache_key = hashlib.sha256(
        f"{source_hash}:44100:2:pcm_f32le".encode("ascii")
    ).hexdigest()
    destination = cache_root.resolve() / cache_key / "analysis.wav"
    if destination.is_file() and destination.stat().st_size > 44:
        mark_cache_entry_used(destination)
        mark_cache_entry_used(destination.parent)
        prune_cache_entries(
            cache_root.parent,
            kinds={cache_root.name},
            protected_paths={destination.parent},
            protected_paths_count_toward_limit=True,
        )
        return destination
    converted = convert_to_analysis_wav(
        source,
        destination,
        ffmpeg_executable=ffmpeg_executable,
    )
    prune_cache_entries(
        cache_root.parent,
        kinds={cache_root.name},
        protected_paths={destination.parent},
    )
    return converted


def playback_audio_info(path: Path) -> PlaybackAudioInfo:
    """PCMストリーミング再生に使用するWaveファイルを検証する。"""

    import soundfile

    resolved = path.resolve()
    if not resolved.is_file():
        raise ValueError(f"再生用Waveファイルが見つかりません: {resolved}")
    with soundfile.SoundFile(str(resolved)) as audio:
        if audio.samplerate != 44_100 or audio.channels != 2:
            raise ValueError(
                "再生用Waveファイルは44.1 kHzステレオである必要があります: "
                f"{resolved}"
            )
        return PlaybackAudioInfo(
            path=str(resolved),
            sampleRate=audio.samplerate,
            channels=audio.channels,
            frameCount=len(audio),
        )


def read_playback_audio_frames(
    source_paths: list[Path],
    start_frame: int,
    frame_count: int,
) -> bytes:
    """複数の44.1 kHz stereo Waveから同じ範囲をfloat32で読み出す。"""

    import numpy as np
    import soundfile

    if not source_paths:
        raise ValueError("再生用Waveファイルが指定されていません")
    if start_frame < 0:
        raise ValueError("再生開始サンプル番号は0以上である必要があります")
    if frame_count < 1 or frame_count > 176_400:
        raise ValueError("再生サンプル数は1～176400である必要があります")

    output = np.zeros((len(source_paths), frame_count, 2), dtype="<f4")
    for source_index, source_path in enumerate(source_paths):
        resolved = source_path.resolve()
        if not resolved.is_file():
            raise ValueError(f"再生用Waveファイルが見つかりません: {resolved}")
        with soundfile.SoundFile(str(resolved)) as audio:
            if audio.samplerate != 44_100 or audio.channels != 2:
                raise ValueError(
                    "再生用Waveファイルは44.1 kHzステレオである必要があります: "
                    f"{resolved}"
                )
            if start_frame >= len(audio):
                continue
            audio.seek(start_frame)
            available = min(frame_count, len(audio) - start_frame)
            output[source_index, :available] = audio.read(
                available,
                dtype="float32",
                always_2d=True,
            )
    return output.tobytes(order="C")
