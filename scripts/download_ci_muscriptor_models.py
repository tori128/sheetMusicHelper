from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download


MODEL_ROOT = Path("models/muscriptor")
MODEL_VARIANTS = ("small", "medium", "large")
MODEL_FILES = ("model.safetensors", "config.json")
MODEL_TOTAL_BYTES = 7_105_675_208
MINIMUM_FREE_BYTES = 55 * 1024**3


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        sys.exit(
            "HF_TOKEN is required. Add a Hugging Face access token to the "
            "windows-release GitHub environment."
        )

    workspace = Path.cwd().resolve()
    model_root = (workspace / MODEL_ROOT).resolve()
    free_bytes = shutil.disk_usage(workspace).free
    required_bytes = MODEL_TOTAL_BYTES + MINIMUM_FREE_BYTES
    if free_bytes < required_bytes:
        sys.exit(
            "Insufficient free space for MuScriptor models: "
            f"{free_bytes} bytes available, {required_bytes} bytes required."
        )

    for variant in MODEL_VARIANTS:
        repository_id = f"MuScriptor/muscriptor-{variant}"
        target_directory = model_root / variant
        target_directory.mkdir(parents=True, exist_ok=True)
        for filename in MODEL_FILES:
            print(f"Downloading {repository_id}/{filename}")
            hf_hub_download(
                repo_id=repository_id,
                filename=filename,
                local_dir=target_directory,
                token=token,
                force_download=True,
            )


if __name__ == "__main__":
    main()
