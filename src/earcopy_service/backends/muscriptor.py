from __future__ import annotations

import gc
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Any

from .base import (
    BackendCapabilities,
    BackendEvent,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
)


class MuscriptorBackend:
    def __init__(
        self,
        *,
        device: str,
        name: str,
        dtypes: tuple[str, ...],
        model_class: Any | None = None,
        torch_module: Any | None = None,
    ) -> None:
        self._device = device
        self._name = name
        self._dtypes = dtypes
        self._model_class = model_class
        self._torch_module = torch_module
        self._model: Any | None = None

    def capabilities(self) -> BackendCapabilities:
        try:
            if self._model_class is None:
                import_module("muscriptor")
            if self._device == "cuda":
                torch = self._torch_module or import_module("torch")
                if not torch.cuda.is_available():
                    return BackendCapabilities(
                        name=self._name,
                        device=self._device,
                        dtypes=self._dtypes,
                        available=False,
                        unavailable_reason="対応するNVIDIA GPUが見つかりません",
                    )
        except ImportError as exc:
            return BackendCapabilities(
                name=self._name,
                device=self._device,
                dtypes=self._dtypes,
                available=False,
                unavailable_reason=f"推論ランタイムを読み込めません: {exc}",
            )

        return BackendCapabilities(
            name=self._name,
            device=self._device,
            dtypes=self._dtypes,
            available=True,
        )

    def load(self, model_path: Path, dtype: str) -> None:
        if dtype not in self._dtypes:
            raise ValueError(
                f"{self._device.upper()}バックエンドは{dtype}に対応していません"
            )
        if not model_path.is_file():
            raise ValueError("MuScriptorモデルが見つかりません")
        capability = self.capabilities()
        if not capability.available:
            raise RuntimeError(capability.unavailable_reason or "推論を開始できません")

        model_class = self._model_class
        if model_class is None:
            try:
                model_class = import_module("muscriptor").TranscriptionModel
            except (ImportError, AttributeError) as exc:
                raise RuntimeError(f"MuScriptorを読み込めません: {exc}") from exc
        self._model = model_class.load_model(
            model_path,
            device=self._device,
            dtype=dtype,
        )

    def transcribe(
        self,
        audio_path: Path,
        instruments: list[str],
        on_event: Callable[[BackendEvent], None],
    ) -> None:
        if self._model is None:
            raise RuntimeError("MuScriptorモデルがロードされていません")
        for event in self._model.transcribe(audio_path, instruments=instruments):
            if all(
                hasattr(event, name)
                for name in ("index", "instrument", "pitch", "start_time")
            ):
                normalized: BackendEvent = BackendNoteStart(
                    event_index=int(event.index),
                    instrument_id=str(event.instrument),
                    pitch=int(event.pitch),
                    start_sec=float(event.start_time),
                )
            elif all(
                hasattr(event, name)
                for name in ("start_event_index", "end_time")
            ):
                normalized = BackendNoteEnd(
                    event_index=int(event.start_event_index),
                    end_sec=float(event.end_time),
                )
            elif all(hasattr(event, name) for name in ("completed", "total")):
                normalized = BackendProgress(
                    completed=int(event.completed),
                    total=int(event.total),
                )
            else:
                raise TypeError(
                    f"未対応のMuScriptorイベントです: {type(event).__name__}"
                )
            on_event(normalized)

    def unload(self) -> None:
        self._model = None
        gc.collect()
        if self._device == "cuda":
            try:
                torch = self._torch_module or import_module("torch")
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
