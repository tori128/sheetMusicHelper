from __future__ import annotations

from typing import Any

from .muscriptor import MuscriptorBackend


class CudaMuscriptorBackend(MuscriptorBackend):
    def __init__(
        self,
        model_class: Any | None = None,
        torch_module: Any | None = None,
    ) -> None:
        super().__init__(
            device="cuda",
            name="MuScriptor PyTorch CUDA",
            dtypes=("float32", "float16"),
            model_class=model_class,
            torch_module=torch_module,
        )
