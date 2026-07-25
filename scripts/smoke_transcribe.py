from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from time import perf_counter

from earcopy_service.backends import CpuMuscriptorBackend, CudaMuscriptorBackend


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ローカルMuScriptorモデルの実推論スモークテスト"
    )
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument(
        "--backend",
        choices=("Auto", "CPU", "CUDA"),
        default="Auto",
    )
    parser.add_argument(
        "--dtype",
        choices=("float32", "float16"),
        default="float32",
    )
    parser.add_argument(
        "--instruments",
        default="acoustic_piano",
        help="カンマ区切りのMuScriptor楽器グループ",
    )
    args = parser.parse_args()

    if args.backend == "CUDA":
        backend = CudaMuscriptorBackend()
    elif args.backend == "CPU":
        backend = CpuMuscriptorBackend()
    else:
        cuda = CudaMuscriptorBackend()
        backend = cuda if cuda.capabilities().available else CpuMuscriptorBackend()
    counts: Counter[str] = Counter()
    started = perf_counter()
    try:
        backend.load(args.model, args.dtype)
        loaded_at = perf_counter()
        backend.transcribe(
            args.audio,
            [item.strip() for item in args.instruments.split(",") if item.strip()],
            lambda event: counts.update([type(event).__name__]),
        )
        completed_at = perf_counter()
    finally:
        backend.unload()

    print(
        json.dumps(
            {
                "modelPath": str(args.model.resolve()),
                "audioPath": str(args.audio.resolve()),
                "backend": backend.capabilities().device.upper(),
                "dtype": args.dtype,
                "loadSeconds": round(loaded_at - started, 3),
                "transcribeSeconds": round(completed_at - loaded_at, 3),
                "events": dict(counts),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
