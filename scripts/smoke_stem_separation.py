from __future__ import annotations

import argparse
import json
import math
import struct
import tempfile
import wave
from pathlib import Path

from earcopy_service.stem_separation import separate_four_stems


def write_input(path: Path, duration_sec: float = 1.0) -> None:
    sample_rate = 44_100
    frames = bytearray()
    for index in range(int(sample_rate * duration_sec)):
        sample = int(8_000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        frames.extend(struct.pack("<hh", sample, sample))
    with wave.open(str(path), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(frames)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="earcopy-scnet-smoke-") as temporary:
        root = Path(temporary)
        source = root / "input.wav"
        write_input(source)
        stems = separate_four_stems(source, root / "stems", args.model_dir)
        metadata = {}
        for stem in stems:
            path = Path(stem.cache_path)
            with wave.open(str(path), "rb") as audio:
                metadata[stem.type] = {
                    "sampleRate": audio.getframerate(),
                    "channels": audio.getnchannels(),
                    "sampleWidth": audio.getsampwidth(),
                    "frames": audio.getnframes(),
                }
        assert set(metadata) == {"drums", "bass", "vocals", "other"}
        assert all(
            item == {
                "sampleRate": 44_100,
                "channels": 2,
                "sampleWidth": 3,
                "frames": 44_100,
            }
            for item in metadata.values()
        )
        print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
