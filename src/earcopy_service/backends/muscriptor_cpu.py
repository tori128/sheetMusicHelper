from __future__ import annotations

from typing import Any

from .muscriptor import MuscriptorBackend


class CpuMuscriptorBackend(MuscriptorBackend):
    def __init__(
        self,
        model_class: Any | None = None,
    ) -> None:
        super().__init__(
            device="cpu",
            name="MuScriptor PyTorch CPU",
            dtypes=("float32",),
            model_class=model_class,
        )
