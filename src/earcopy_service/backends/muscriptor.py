from __future__ import annotations

import contextlib
import gc
import logging
import re
import threading
import warnings
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Any, Literal

from .base import (
    BackendCapabilities,
    BackendEvent,
    BackendInvalidChunk,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
)


_MODEL_LOAD_LOCK = threading.Lock()
_LOGGER = logging.getLogger(__name__)
_RUNAWAY_CHUNK_PATTERN = re.compile(
    r"^chunk (?P<index>\d+) \(seek=(?P<seek>\d+(?:\.\d+)?)s\) "
    r"did not emit EOS within (?P<tokens>\d+) tokens$"
)
_ABORTED_CHUNK_PATTERN = re.compile(
    r"^chunk (?P<index>\d+) \(seek=(?P<seek>\d+(?:\.\d+)?)s\) "
    r"was discarded after guarded generation: .+$"
)
MUSCRIPTOR_CHUNK_DURATION_SEC = 5.0
_MAX_STAGNANT_GENERATION_STEPS = 320
_MAX_DUPLICATE_NOTE_STARTS = 8


class _RunawayGeneration(RuntimeError):
    pass


class _TokenGenerationGuard:
    def __init__(
        self,
        vocab: list[Any],
    ) -> None:
        self._vocab = vocab
        self._maximum_shift = -1
        self._stagnant_steps = 0
        self._in_tie_prelude = True
        self._program: int | None = None
        self._velocity: int | None = None
        self._duplicate_note_starts: dict[tuple[int, int, int], int] = {}
        self._duplicate_beam_pitches: dict[tuple[int, int], int] = {}

    def observe(self, token_ids: list[int], *, track_duplicates: bool) -> None:
        events = [self._vocab[token_id] for token_id in token_ids]
        advancing_shifts = [
            int(event.value)
            for event in events
            if event.type == "shift" and int(event.value) > self._maximum_shift
        ]
        if advancing_shifts:
            self._maximum_shift = max(advancing_shifts)
            self._stagnant_steps = 0
        else:
            self._stagnant_steps += 1
            if self._stagnant_steps >= _MAX_STAGNANT_GENERATION_STEPS:
                raise _RunawayGeneration(
                    "musical time did not advance for "
                    f"{_MAX_STAGNANT_GENERATION_STEPS} generation steps"
                )

        if not track_duplicates:
            pitch_token_ids = {
                token_id
                for token_id, event in zip(token_ids, events, strict=True)
                if event.type in {"pitch", "drum"}
            }
            if len(pitch_token_ids) == 1 and len(pitch_token_ids) == len(
                {event.type for event in events}
            ):
                token_id = next(iter(pitch_token_ids))
                key = (self._maximum_shift, token_id)
                count = self._duplicate_beam_pitches.get(key, 0) + 1
                self._duplicate_beam_pitches[key] = count
                if count >= _MAX_DUPLICATE_NOTE_STARTS:
                    raise _RunawayGeneration(
                        "all beam candidates repeated the same onset and pitch "
                        f"{_MAX_DUPLICATE_NOTE_STARTS} times"
                    )
            return
        if len(events) != 1:
            return
        event = events[0]
        if self._in_tie_prelude:
            if event.type == "tie":
                self._in_tie_prelude = False
                self._velocity = None
            elif event.type == "shift":
                self._in_tie_prelude = False
            else:
                return
        if event.type == "program":
            self._program = int(event.value)
            return
        if event.type == "velocity":
            self._velocity = int(event.value)
            return
        if event.type == "pitch":
            if self._program is None or self._velocity is None or self._velocity <= 0:
                return
            key = (self._maximum_shift, self._program, int(event.value))
        elif event.type == "drum":
            key = (self._maximum_shift, -1, int(event.value))
        else:
            return
        count = self._duplicate_note_starts.get(key, 0) + 1
        self._duplicate_note_starts[key] = count
        if count >= _MAX_DUPLICATE_NOTE_STARTS:
            raise _RunawayGeneration(
                "the same onset, instrument, and pitch were generated "
                f"{_MAX_DUPLICATE_NOTE_STARTS} times"
            )


def _step_token_ids(step: Any) -> list[int]:
    values = step.tolist()
    if isinstance(values, list):
        return [int(value) for value in values]
    return [int(values)]


class _CachedGenerationStep:
    __slots__ = ("_token_ids",)

    def __init__(self, token_ids: list[int]) -> None:
        self._token_ids = tuple(token_ids)

    def tolist(self) -> list[int]:
        return list(self._token_ids)


def _collect_guarded_generation(
    lm_model: Any,
    original_generate: Callable[..., Any],
    vocab: list[Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> list[Any]:
    beam_size = int(kwargs.get("beam_size", 1))
    eos_id = kwargs.get("early_stop_on_token")
    guard = _TokenGenerationGuard(vocab)
    original_compute_logits = getattr(lm_model, "_compute_logits", None)
    compute_started = False

    if beam_size > 1 and callable(original_compute_logits):
        def guarded_compute_logits(
            sequence: Any,
            *inner_args: Any,
            **inner_kwargs: Any,
        ) -> Any:
            nonlocal compute_started
            if compute_started:
                guard.observe(
                    _step_token_ids(sequence[:, -1]),
                    track_duplicates=False,
                )
            compute_started = True
            return original_compute_logits(sequence, *inner_args, **inner_kwargs)

        lm_model._compute_logits = guarded_compute_logits

    generator = None
    buffered_steps: list[Any] = []
    emitted_eos: list[bool] | None = None
    try:
        generation_kwargs = kwargs
        if beam_size == 1 and eos_id is not None:
            generation_kwargs = dict(kwargs)
            generation_kwargs["early_stop_on_token"] = None
        generator = original_generate(*args, **generation_kwargs)
        for step in generator:
            token_ids = _step_token_ids(step)
            if beam_size == 1:
                guard.observe(token_ids, track_duplicates=True)
            if eos_id is not None:
                if emitted_eos is None:
                    emitted_eos = [False] * len(token_ids)
                for index, token_id in enumerate(token_ids):
                    emitted_eos[index] = (
                        emitted_eos[index] or token_id == int(eos_id)
                    )
            buffered_steps.append(_CachedGenerationStep(token_ids))
            if emitted_eos is not None and all(emitted_eos):
                break
    finally:
        close = getattr(generator, "close", None)
        if callable(close):
            close()
        if beam_size > 1 and callable(original_compute_logits):
            lm_model._compute_logits = original_compute_logits

    if eos_id is not None and (
        emitted_eos is None or not all(emitted_eos)
    ):
        raise _RunawayGeneration(
            f"EOS was not emitted within {kwargs.get('max_gen_len', 'the configured')} tokens"
        )
    return buffered_steps


@contextlib.contextmanager
def _guarded_muscriptor_generation(
    transcription_model: Any,
) -> Any:
    lm_model = getattr(transcription_model, "_model", None)
    tokenizer = getattr(transcription_model, "_tokenizer", None)
    original_generate = getattr(lm_model, "generate", None)
    vocab = getattr(tokenizer, "_vocab", None)
    if not callable(original_generate) or not isinstance(vocab, list):
        yield
        return

    chunk_index = 0

    def guarded_generate(*args: Any, **kwargs: Any) -> Any:
        nonlocal chunk_index
        current_chunk = chunk_index
        chunk_index += 1
        attempts: list[dict[str, Any]] = [dict(kwargs)]
        first_beam_size = int(kwargs.get("beam_size", 1))
        if first_beam_size > 1 or kwargs.get("forbidden_tokens") is not None:
            retry = dict(kwargs)
            retry["beam_size"] = 1
            retry["forbidden_tokens"] = None
            attempts.append(retry)

        failure_reasons: list[str] = []
        for attempt_index, attempt in enumerate(attempts):
            try:
                steps = _collect_guarded_generation(
                    lm_model,
                    original_generate,
                    vocab,
                    args,
                    attempt,
                )
            except _RunawayGeneration as exc:
                failure_reasons.append(str(exc))
                continue
            if attempt_index > 0:
                _LOGGER.warning(
                    "MuScriptor chunk %d recovered on fallback generation (%s)",
                    current_chunk,
                    failure_reasons[-1],
                )
            yield from steps
            return

        reason = "; fallback: ".join(failure_reasons)
        warnings.warn(
            f"chunk {current_chunk} "
            f"(seek={current_chunk * MUSCRIPTOR_CHUNK_DURATION_SEC:.1f}s) "
            f"was discarded after guarded generation: {reason}",
            RuntimeWarning,
            stacklevel=2,
        )
        eos_id = kwargs.get("early_stop_on_token")
        conditions = kwargs.get("conditions") or []
        sample_count = kwargs.get("num_samples") or len(conditions) or 1
        torch = import_module("torch")
        yield torch.full(
            (sample_count,),
            int(eos_id),
            device=lm_model.emb.weight.device,
            dtype=torch.long,
        )

    lm_model.generate = guarded_generate
    try:
        yield
    finally:
        lm_model.generate = original_generate


def _load_model(
    model_class: Any,
    model_path: Path,
    device: str,
    dtype: str,
    torch: Any | None,
) -> Any:
    if device != "cuda" or dtype != "float16" or torch is None:
        return model_class.load_model(
            model_path,
            device=device,
            dtype=dtype,
        )

    model_module = import_module(model_class.__module__)
    load_file = getattr(model_module, "load_file", None)
    if not callable(load_file):
        return model_class.load_model(
            model_path,
            device=device,
            dtype=dtype,
        )

    def load_weights_on_cpu(path: Any, device: Any = None) -> Any:
        del device
        return load_file(path, device="cpu")

    # MuScriptor 0.2.2 otherwise creates both the model and its FP32 state
    # dictionary on CUDA before converting the model to FP16.
    with _MODEL_LOAD_LOCK:
        original_dtype = torch.get_default_dtype()
        model_module.load_file = load_weights_on_cpu
        torch.set_default_dtype(torch.float16)
        try:
            return model_class.load_model(
                model_path,
                device=device,
                dtype=dtype,
            )
        finally:
            torch.set_default_dtype(original_dtype)
            model_module.load_file = load_file


def _configure_loaded_model(
    model: Any,
    device: str,
    dtype: str,
) -> Any:
    if device != "cuda" or dtype != "float16":
        return model
    lm_model = getattr(model, "_model", None)
    autocast = getattr(lm_model, "autocast", None)
    if hasattr(autocast, "enabled"):
        # Explicit FP16 weights already execute the transformer in FP16.
        # CUDA autocast repeats dtype dispatch and tensor conversion for every
        # decoder layer and generated token.
        autocast.enabled = False
    return model


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
        torch = None
        if self._device == "cuda":
            torch = self._torch_module or import_module("torch")
        try:
            self._model = _configure_loaded_model(
                _load_model(
                    model_class,
                    model_path,
                    self._device,
                    dtype,
                    torch,
                ),
                self._device,
                dtype,
            )
        finally:
            if torch is not None:
                self._release_cuda_memory(torch)

    def transcribe(
        self,
        audio_path: Path,
        instruments: list[str] | None,
        on_event: Callable[[BackendEvent], None],
        *,
        beam_size: Literal[1, 2] = 1,
        prelude_forcing: bool = True,
        batch_size: int = 1,
    ) -> None:
        if self._model is None:
            raise RuntimeError("MuScriptorモデルがロードされていません")
        warning_cursor = 0
        torch = self._torch_module
        if torch is None:
            try:
                torch = import_module("torch")
            except ImportError:
                torch = None
        inference_mode = getattr(torch, "inference_mode", None)
        inference_context = (
            inference_mode()
            if callable(inference_mode)
            else contextlib.nullcontext()
        )
        with inference_context, warnings.catch_warnings(
            record=True
        ) as caught_warnings:
            warnings.simplefilter("always")

            def publish_new_warnings() -> None:
                nonlocal warning_cursor
                for warning in caught_warnings[warning_cursor:]:
                    message = str(warning.message)
                    match = _RUNAWAY_CHUNK_PATTERN.fullmatch(message)
                    if match is None:
                        match = _ABORTED_CHUNK_PATTERN.fullmatch(message)
                    if match is not None:
                        start_sec = float(match.group("seek"))
                        on_event(
                            BackendInvalidChunk(
                                chunk_index=int(match.group("index")),
                                start_sec=start_sec,
                                end_sec=start_sec
                                + MUSCRIPTOR_CHUNK_DURATION_SEC,
                                reason=message,
                            )
                        )
                    else:
                        warnings.showwarning(
                            warning.message,
                            warning.category,
                            warning.filename,
                            warning.lineno,
                            warning.file,
                            warning.line,
                        )
                warning_cursor = len(caught_warnings)

            with _guarded_muscriptor_generation(self._model):
                events = self._model.transcribe(
                    audio_path,
                    instruments=instruments,
                    prelude_forcing=prelude_forcing,
                    batch_size=batch_size,
                    beam_size=beam_size,
                )
                for event in self._events_with_cuda_cleanup(events):
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
                    elif all(
                        hasattr(event, name) for name in ("completed", "total")
                    ):
                        publish_new_warnings()
                        normalized = BackendProgress(
                            completed=int(event.completed),
                            total=int(event.total),
                        )
                    else:
                        raise TypeError(
                            f"未対応のMuScriptorイベントです: {type(event).__name__}"
                        )
                    on_event(normalized)
                publish_new_warnings()

    def _events_with_cuda_cleanup(self, events: Any) -> Any:
        try:
            yield from events
        finally:
            close = getattr(events, "close", None)
            if callable(close):
                close()
            if self._device == "cuda":
                torch = self._torch_module or import_module("torch")
                self._release_cuda_memory(torch)

    def unload(self) -> None:
        self._model = None
        if self._device == "cuda":
            try:
                torch = self._torch_module or import_module("torch")
                self._release_cuda_memory(torch)
            except ImportError:
                pass
        else:
            gc.collect()

    @staticmethod
    def _release_cuda_memory(torch: Any) -> None:
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
