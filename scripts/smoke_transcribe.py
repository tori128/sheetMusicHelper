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
    parser.add_argument(
        "--all-instruments",
        action="store_true",
        help="MuScriptorの全楽器グループを候補にする",
    )
    parser.add_argument(
        "--prelude-forcing",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--batch-size", type=int, default=1)
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("--batch-sizeは1以上で指定してください")

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
        torch = None
        if backend.capabilities().device.upper() == "CUDA":
            import torch as torch_module

            torch = torch_module
            torch.cuda.reset_peak_memory_stats()
        backend.transcribe(
            args.audio,
            (
                None
                if args.all_instruments
                else [
                    item.strip()
                    for item in args.instruments.split(",")
                    if item.strip()
                ]
            ),
            lambda event: counts.update([type(event).__name__]),
            prelude_forcing=args.prelude_forcing,
            batch_size=args.batch_size,
        )
        if torch is not None:
            torch.cuda.synchronize()
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
                "preludeForcing": args.prelude_forcing,
                "batchSize": args.batch_size,
                "loadSeconds": round(loaded_at - started, 3),
                "transcribeSeconds": round(completed_at - loaded_at, 3),
                "events": dict(counts),
                "peakAllocatedMemoryMiB": (
                    round(torch.cuda.max_memory_allocated() / 1024**2, 1)
                    if torch is not None
                    else None
                ),
                "peakReservedMemoryMiB": (
                    round(torch.cuda.max_memory_reserved() / 1024**2, 1)
                    if torch is not None
                    else None
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
