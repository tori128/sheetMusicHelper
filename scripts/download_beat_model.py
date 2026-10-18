from __future__ import annotations

import hashlib
from pathlib import Path

import httpx

from earcopy_service.beat_analysis import BEAT_MODEL_BYTES, BEAT_MODEL_SHA256

MODEL_URL = "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt"


def verify(path: Path) -> None:
    if path.stat().st_size != BEAT_MODEL_BYTES:
        raise ValueError("Beat This! final0 file size does not match")
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != BEAT_MODEL_SHA256:
            raise ValueError("Beat This! final0 SHA-256 does not match")


def main() -> None:
    destination = Path(__file__).resolve().parents[1] / "models/beat-this/final0.ckpt"
    if destination.is_file():
        verify(destination)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".ckpt.download")
        try:
            with httpx.stream("GET", MODEL_URL, follow_redirects=True, timeout=60) as response:
                response.raise_for_status()
                with temporary.open("wb") as target:
                    for chunk in response.iter_bytes():
                        target.write(chunk)
            verify(temporary)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"Beat This! final0 verified: {BEAT_MODEL_BYTES} bytes, SHA-256 {BEAT_MODEL_SHA256}")


if __name__ == "__main__":
    main()
