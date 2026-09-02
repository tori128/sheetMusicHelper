from __future__ import annotations

import gc
import hashlib
import math
import os
import shutil
import threading
import traceback
import wave
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import httpx

from .cache_management import mark_cache_entry_used, prune_cache_entries
from .diagnostics import diagnostics_enabled, log_backend_event
from .models import Stem

STEM_NAMES: Final = (
    "drums",
    "bass",
    "vocals",
    "other",
    "piano",
    "guitar",
)
TRANSCRIPTION_ROUTING_VERSION: Final = "direct-six-v1"
BS_ROFORMER_SW_MODEL_FILE: Final = "BS-Rofo-SW-Fixed.ckpt"
BS_ROFORMER_SW_MODEL_SHA256: Final = (
    "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
)
BS_ROFORMER_SW_MODEL_SIZE_BYTES: Final = 699_412_152
BS_ROFORMER_SW_SOURCE_ORDER: Final = (
    "bass",
    "drums",
    "other",
    "vocals",
    "guitar",
    "piano",
)
STEM_SAMPLE_RATE: Final = 44_100
BASS_DRUM_GUIDE_HIGHPASS_HZ: Final = 350.0
BASS_DRUM_GUIDE_FILTER_ORDER: Final = 4


@dataclass(frozen=True, slots=True)
class StemModelProfile:
    key: str
    display_name: str
    relative_directory: Path
    model_file: str
    model_sha256: str
    source_order: tuple[str, ...]
    num_stems: int
    segment_samples: int
    num_overlap: int
    batch_size: int
    attention_dropout: float
    feed_forward_dropout: float

    @property
    def cache_version(self) -> str:
        return f"{self.key}-{self.model_sha256[:12]}"


@dataclass(frozen=True, slots=True)
class StemModelDistribution:
    source_page_url: str
    download_url: str
    license_status: str
    model_size_bytes: int


@dataclass(frozen=True, slots=True)
class StemInferenceSettings:
    profile: StemModelProfile
    segment_samples: int
    num_overlap: int
    batch_size: int
    normalize: bool
    use_amp: bool
    source_order: tuple[str, ...] = BS_ROFORMER_SW_SOURCE_ORDER


BS_ROFORMER_SW_PROFILE: Final = StemModelProfile(
    key="bs-roformer-sw-fixed",
    display_name="BS-RoFormer SW Fixed",
    relative_directory=Path("models") / "bs-roformer" / "sw-fixed",
    model_file=BS_ROFORMER_SW_MODEL_FILE,
    model_sha256=BS_ROFORMER_SW_MODEL_SHA256,
    source_order=BS_ROFORMER_SW_SOURCE_ORDER,
    num_stems=6,
    segment_samples=588_800,
    num_overlap=2,
    batch_size=1,
    attention_dropout=0.1,
    feed_forward_dropout=0.1,
)
BS_ROFORMER_SW_DISTRIBUTION: Final = StemModelDistribution(
    source_page_url=(
        "https://huggingface.co/jarredou/BS-ROFO-SW-Fixed/tree/"
        "ad54168acf271482ad51702953e162a385b8fdcb"
    ),
    download_url=(
        "https://huggingface.co/jarredou/BS-ROFO-SW-Fixed/resolve/"
        "ad54168acf271482ad51702953e162a385b8fdcb/"
        "BS-Rofo-SW-Fixed.ckpt?download=true"
    ),
    license_status="Unknown",
    model_size_bytes=BS_ROFORMER_SW_MODEL_SIZE_BYTES,
)
_STEM_MODEL_DOWNLOAD_LOCK = threading.Lock()
STEM_CACHE_VERSION: Final = (
    f"{BS_ROFORMER_SW_PROFILE.cache_version}-{TRANSCRIPTION_ROUTING_VERSION}"
)


class StemSeparationCancelled(Exception):
    pass


def _check_cancelled(cancel_check: Callable[[], bool] | None) -> None:
    if cancel_check is not None and cancel_check():
        raise StemSeparationCancelled


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stem_profile_for_directory(
    model_directory: Path,
) -> StemModelProfile | None:
    if (model_directory / BS_ROFORMER_SW_MODEL_FILE).is_file():
        return BS_ROFORMER_SW_PROFILE
    return None


def configured_stem_model() -> tuple[Path, StemModelProfile]:
    configured = os.getenv("EARCOPY_STEM_MODEL_DIR")
    candidates = (
        [
            Path(configured),
            Path(configured) / "bs-roformer" / "sw-fixed",
            Path(configured) / "sw-fixed",
        ]
        if configured
        else [BS_ROFORMER_SW_PROFILE.relative_directory]
    )
    for candidate in candidates:
        profile = _stem_profile_for_directory(candidate)
        if profile is not None:
            return candidate.resolve(), profile
    expectations = [
        f"{candidate.resolve(strict=False)} ({BS_ROFORMER_SW_MODEL_FILE})"
        for candidate in candidates
    ]
    raise FileNotFoundError(
        "音源分離モデルが見つかりません。配置先: "
        + " / ".join(expectations)
    )


def configured_stem_model_directory() -> Path:
    return configured_stem_model()[0]


def stem_model_install_directory() -> Path:
    configured = os.getenv("EARCOPY_STEM_MODEL_DIR")
    if not configured:
        return BS_ROFORMER_SW_PROFILE.relative_directory.resolve(strict=False)
    configured_path = Path(configured)
    if configured_path.name.casefold() == "sw-fixed":
        return configured_path.resolve(strict=False)
    if configured_path.name.casefold() == "bs-roformer":
        return (configured_path / "sw-fixed").resolve(strict=False)
    return (
        configured_path / "bs-roformer" / "sw-fixed"
    ).resolve(strict=False)


def configured_stem_cache_version() -> str:
    try:
        return (
            f"{configured_stem_model()[1].cache_version}-"
            f"{TRANSCRIPTION_ROUTING_VERSION}"
        )
    except FileNotFoundError:
        return STEM_CACHE_VERSION


def stem_model_status() -> dict[str, bool | str | int]:
    distribution = BS_ROFORMER_SW_DISTRIBUTION
    common: dict[str, bool | str | int] = {
        "modelFileName": BS_ROFORMER_SW_PROFILE.model_file,
        "modelSizeBytes": distribution.model_size_bytes,
        "modelSha256": BS_ROFORMER_SW_PROFILE.model_sha256,
        "licenseStatus": distribution.license_status,
        "sourcePageUrl": distribution.source_page_url,
    }
    try:
        model_directory, profile = configured_stem_model()
    except FileNotFoundError as exc:
        status: dict[str, bool | str | int] = {
            **common,
            "available": False,
            "modelDirectory": str(stem_model_install_directory()),
            "modelName": BS_ROFORMER_SW_PROFILE.display_name,
            "reason": str(exc),
        }
    else:
        status = {
            **common,
            "available": True,
            "modelDirectory": str(model_directory),
            "modelName": profile.display_name,
            "reason": "",
        }
    return status


def download_stem_model(
    client: httpx.Client | None = None,
) -> dict[str, bool | str | int]:
    profile = BS_ROFORMER_SW_PROFILE
    distribution = BS_ROFORMER_SW_DISTRIBUTION
    with _STEM_MODEL_DOWNLOAD_LOCK:
        model_directory = stem_model_install_directory()
        model_directory.mkdir(parents=True, exist_ok=True)
        model_path = model_directory / profile.model_file
        if model_path.is_file():
            try:
                _validate_model(model_directory, profile)
                return stem_model_status()
            except ValueError:
                pass

        available_bytes = shutil.disk_usage(model_directory).free
        if available_bytes < distribution.model_size_bytes:
            raise OSError(
                "音源分離モデルの保存領域が不足しています: "
                f"required={distribution.model_size_bytes}, "
                f"available={available_bytes}, path={model_directory}"
            )

        temporary_path = model_path.with_name(f"{model_path.name}.download")
        temporary_path.unlink(missing_ok=True)
        owns_client = client is None
        active_client = client or httpx.Client(
            follow_redirects=True,
            timeout=httpx.Timeout(60.0, connect=30.0),
        )
        try:
            digest = hashlib.sha256()
            received_bytes = 0
            with active_client.stream(
                "GET",
                distribution.download_url,
                headers={
                    "Accept": "application/octet-stream",
                    "Accept-Encoding": "identity",
                    "User-Agent": "EarCopy-Assist/0.1",
                },
            ) as response:
                response.raise_for_status()
                content_length = response.headers.get("Content-Length")
                if (
                    content_length is not None
                    and int(content_length) != distribution.model_size_bytes
                ):
                    raise ValueError(
                        "音源分離モデルの配布サイズが一致しません: "
                        f"expected={distribution.model_size_bytes}, "
                        f"actual={content_length}"
                    )
                with temporary_path.open("xb") as destination:
                    for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                        received_bytes += len(chunk)
                        if received_bytes > distribution.model_size_bytes:
                            raise ValueError(
                                "音源分離モデルの受信サイズが上限を超えました"
                            )
                        destination.write(chunk)
                        digest.update(chunk)
                    destination.flush()
                    os.fsync(destination.fileno())
            if received_bytes != distribution.model_size_bytes:
                raise ValueError(
                    "音源分離モデルの受信サイズが一致しません: "
                    f"expected={distribution.model_size_bytes}, "
                    f"actual={received_bytes}"
                )
            actual_sha256 = digest.hexdigest()
            if actual_sha256 != profile.model_sha256:
                raise ValueError(
                    "音源分離モデルのSHA-256が一致しません: "
                    f"expected={profile.model_sha256}, actual={actual_sha256}"
                )
            temporary_path.replace(model_path)
        except httpx.HTTPError as exc:
            raise RuntimeError(
                f"音源分離モデルのダウンロードに失敗しました: {exc}"
            ) from exc
        finally:
            temporary_path.unlink(missing_ok=True)
            if owns_client:
                active_client.close()
        return stem_model_status()


def validate_stem_model(model_directory: Path) -> Path:
    return _validate_model(model_directory, BS_ROFORMER_SW_PROFILE)


def _validate_model(
    model_directory: Path,
    profile: StemModelProfile,
) -> Path:
    model_path = model_directory / profile.model_file
    if not model_path.is_file():
        raise FileNotFoundError(
            f"{profile.display_name}モデルが見つかりません: {model_path}"
        )
    actual_model = _sha256(model_path)
    if actual_model != profile.model_sha256:
        raise ValueError(
            f"{profile.display_name}モデルのSHA-256が一致しません: "
            f"expected={profile.model_sha256}, actual={actual_model}"
        )
    return model_path


def _load_stem_model(
    model_directory: Path,
    device: Any | None = None,
) -> tuple[Any, StemInferenceSettings]:
    import torch

    profile = _stem_profile_for_directory(model_directory)
    if profile is None:
        raise ValueError(f"未対応の分離モデル構成です: {model_directory}")
    model_path = _validate_model(model_directory, profile)

    from ._vendor.bs_roformer import BSRoformer

    model = BSRoformer(
        dimension=256,
        depth=12,
        stereo=True,
        num_stems=profile.num_stems,
        time_transformer_depth=1,
        frequency_transformer_depth=1,
        linear_transformer_depth=0,
        head_dimension=64,
        heads=8,
        attention_dropout=profile.attention_dropout,
        feed_forward_dropout=profile.feed_forward_dropout,
        flash_attention=True,
        stft_n_fft=2048,
        stft_hop_length=512,
        stft_win_length=2048,
        stft_normalized=False,
        mask_estimator_depth=2,
        mlp_expansion_factor=4,
        skip_connection=False,
    )

    checkpoint = torch.load(
        model_path,
        map_location=torch.device("cpu"),
        weights_only=True,
    )
    if not isinstance(checkpoint, dict):
        raise ValueError(
            f"{profile.display_name}チェックポイントが辞書形式ではありません"
        )
    if isinstance(checkpoint.get("state_dict"), dict):
        checkpoint = checkpoint["state_dict"]
    state = {
        key.removeprefix("module.").removeprefix("model."): value
        for key, value in checkpoint.items()
    }
    model.load_state_dict(state, strict=True)
    model.to(device or torch.device("cpu"))
    model.eval()

    return model, StemInferenceSettings(
        profile=profile,
        segment_samples=profile.segment_samples,
        num_overlap=profile.num_overlap,
        batch_size=profile.batch_size,
        normalize=False,
        use_amp=True,
        source_order=profile.source_order,
    )


def _convert_audio(waveform: Any, sample_rate: int) -> Any:
    import torchaudio

    if waveform.ndim != 2 or waveform.shape[0] < 1:
        raise ValueError(f"音声テンソルの形状が不正です: {waveform.shape}")
    if waveform.shape[0] == 1:
        waveform = waveform.expand(2, -1)
    elif waveform.shape[0] > 2:
        waveform = waveform[:2]
    if sample_rate != STEM_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(
            waveform,
            sample_rate,
            STEM_SAMPLE_RATE,
        )
    return waveform


def _cuda_memory_log_fields(torch: Any, device: Any) -> str:
    device_index = device.index
    if device_index is None:
        device_index = torch.cuda.current_device()
    free_bytes, total_bytes = torch.cuda.mem_get_info(device_index)
    return (
        f" cuda_allocated={torch.cuda.memory_allocated(device_index)}"
        f" cuda_reserved={torch.cuda.memory_reserved(device_index)}"
        f" cuda_free={free_bytes} cuda_total={total_bytes}"
    )


def _apply_stem_model(
    model: Any,
    waveform: Any,
    segment_samples: int,
    num_overlap: int = 2,
    batch_size: int = 1,
    use_amp: bool = False,
    device: Any | None = None,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[int, int], None] | None = None,
    source_count: int = len(BS_ROFORMER_SW_SOURCE_ORDER),
) -> Any:
    import torch
    import torch.nn.functional as functional

    inference_device = torch.device(device) if device is not None else waveform.device
    segment = max(1, segment_samples)
    stride = max(1, segment // num_overlap)
    original_length = waveform.shape[-1]
    border = segment - stride
    should_trim_border = original_length > 2 * border and border > 0
    if should_trim_border:
        waveform = functional.pad(waveform, (border, border), mode="reflect")
    length = waveform.shape[-1]
    output = torch.zeros(
        1,
        source_count,
        2,
        length,
        dtype=waveform.dtype,
    )
    weight_sum = torch.zeros(length, dtype=waveform.dtype)
    fade_size = max(1, segment // 10)
    weight = torch.ones(segment, dtype=waveform.dtype)
    weight[:fade_size] = torch.linspace(
        0,
        1,
        fade_size,
        dtype=waveform.dtype,
    )
    weight[-fade_size:] = torch.linspace(
        1,
        0,
        fade_size,
        dtype=waveform.dtype,
    )
    chunk_count = (length + stride - 1) // stride
    pending_chunks: list[Any] = []
    pending_locations: list[tuple[int, int, int]] = []
    if progress_callback is not None:
        progress_callback(0, chunk_count)

    with torch.inference_mode():
        for chunk_index, offset in enumerate(range(0, length, stride), start=1):
            _check_cancelled(cancel_check)
            if diagnostics_enabled() and (
                chunk_index == 1
                or chunk_index == chunk_count
                or chunk_index % 10 == 0
            ):
                memory = ""
                if inference_device.type == "cuda":
                    memory = _cuda_memory_log_fields(torch, inference_device)
                log_backend_event(
                    "stem-separation",
                    (
                        f"chunk={chunk_index}/{chunk_count} offset={offset}"
                        f" device={inference_device.type}{memory}"
                    ),
                )
            chunk = waveform[..., offset : offset + segment]
            chunk_length = chunk.shape[-1]
            pad_mode = (
                "reflect"
                if chunk_length > segment // 2 and chunk_length > 1
                else "constant"
            )
            chunk = functional.pad(
                chunk,
                (0, segment - chunk_length),
                mode=pad_mode,
                value=0,
            )
            pending_chunks.append(chunk)
            pending_locations.append((chunk_index, offset, chunk_length))
            if (
                len(pending_chunks) < batch_size
                and chunk_index < chunk_count
            ):
                continue

            batch = torch.stack(pending_chunks).to(inference_device)
            with torch.cuda.amp.autocast(
                enabled=use_amp and inference_device.type == "cuda"
            ):
                estimates = model(batch).to(waveform.device)
            _check_cancelled(cancel_check)
            for estimate, (_, start, estimated_length) in zip(
                estimates,
                pending_locations,
                strict=True,
            ):
                chunk_weight = weight[:estimated_length].clone()
                if start == 0:
                    chunk_weight[:fade_size] = 1
                if start + stride >= length:
                    chunk_weight[-fade_size:] = 1
                output[..., start : start + estimated_length] += (
                    estimate[..., :estimated_length] * chunk_weight
                )
                weight_sum[start : start + estimated_length] += chunk_weight
            if progress_callback is not None:
                progress_callback(pending_locations[-1][0], chunk_count)
            pending_chunks.clear()
            pending_locations.clear()

    if weight_sum.min() <= 0:
        raise RuntimeError("分離モデルの結果を結合できませんでした")
    result = output[0] / weight_sum
    if should_trim_border:
        result = result[..., border:-border]
    return result[..., :original_length]


def _separate_with_device(
    repository: Path,
    waveform: Any,
    device: Any,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[int, int], None] | None = None,
) -> Any:
    import torch

    inference_device = torch.device(device)
    model: Any | None = None
    try:
        log_backend_event(
            "stem-separation",
            f"load_model device={inference_device.type} directory={repository}",
        )
        _check_cancelled(cancel_check)
        model, settings = _load_stem_model(
            repository,
            inference_device,
        )
        log_backend_event(
            "stem-separation",
            (
                f"model_loaded name={settings.profile.display_name} "
                f"device={inference_device.type} "
                f"segment_samples={settings.segment_samples} "
                f"overlap={settings.num_overlap} "
                f"batch_size={settings.batch_size} "
                f"normalize={settings.normalize} amp={settings.use_amp}"
            ),
        )
        _check_cancelled(cancel_check)
        reference = waveform.mean(0)
        reference_mean = reference.mean()
        reference_std = reference.std()
        inference_waveform = waveform
        if settings.normalize:
            inference_waveform = (
                waveform - reference_mean
            ) / reference_std

        requested_batch_size = (
            settings.batch_size
            if inference_device.type == "cuda"
            else 1
        )
        active_batch_size = requested_batch_size
        while True:
            try:
                apply_options = {
                    "num_overlap": settings.num_overlap,
                    "batch_size": active_batch_size,
                    "use_amp": settings.use_amp,
                    "device": inference_device,
                    "cancel_check": cancel_check,
                    "progress_callback": progress_callback,
                }
                if len(settings.source_order) != len(
                    BS_ROFORMER_SW_SOURCE_ORDER
                ):
                    apply_options["source_count"] = len(
                        settings.source_order
                    )
                separated = _apply_stem_model(
                    model,
                    inference_waveform,
                    settings.segment_samples,
                    **apply_options,
                )
                break
            except torch.cuda.OutOfMemoryError as exc:
                if (
                    inference_device.type != "cuda"
                    or active_batch_size <= 1
                ):
                    raise
                traceback.clear_frames(exc.__traceback__)
                active_batch_size = max(1, active_batch_size // 2)
                log_backend_event(
                    "stem-separation",
                    (
                        "cuda_out_of_memory retry=true "
                        f"batch_size={active_batch_size}"
                    ),
                )
                _release_cuda_memory(torch)

        if settings.normalize:
            separated = separated * reference_std + reference_mean
        if separated.device.type != "cpu":
            separated = separated.cpu()
        log_backend_event(
            "stem-separation",
            f"inference_completed device={inference_device.type}",
        )
        return separated
    except BaseException as exc:
        # Completed inference frames otherwise keep the CUDA model alive
        # through the exception traceback during CPU fallback.
        traceback.clear_frames(exc.__traceback__)
        raise
    finally:
        model = None
        if inference_device.type == "cuda":
            _release_cuda_memory(torch)


def _release_cuda_memory(torch: Any) -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _separate_with_fallback(
    torch: Any,
    repository: Path,
    waveform: Any,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[int, int], None] | None = None,
) -> Any:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    try:
        return _separate_with_device(
            repository,
            waveform,
            device,
            cancel_check=cancel_check,
            progress_callback=progress_callback,
        )
    except torch.cuda.OutOfMemoryError:
        if device.type != "cuda":
            raise
        log_backend_event(
            "stem-separation",
            "cuda_out_of_memory fallback=cpu",
        )
        _release_cuda_memory(torch)
        return _separate_with_device(
            repository,
            waveform,
            torch.device("cpu"),
            cancel_check=cancel_check,
            progress_callback=progress_callback,
        )
    finally:
        if device.type == "cuda":
            _release_cuda_memory(torch)


def _separated_stems_by_name(
    separated: Any,
    source_order: tuple[str, ...],
) -> dict[str, Any]:
    if separated.ndim != 3 or separated.shape[0] != len(source_order):
        raise ValueError(
            "分離結果のステム数が不正です: "
            f"shape={tuple(separated.shape)}, sources={source_order}"
        )
    by_name = dict(zip(source_order, separated, strict=True))
    missing = set(STEM_NAMES) - set(by_name)
    if missing:
        raise ValueError(f"分離結果に必要な成分がありません: {sorted(missing)}")
    return {name: by_name[name] for name in STEM_NAMES}


def separation_output_stems(stems: list[Stem]) -> list[Stem]:
    by_type = {stem.type: stem for stem in stems}
    missing = set(STEM_NAMES) - set(by_type)
    if missing:
        raise ValueError(
            f"分離WAVを出力できないため、分離成分を確認してください: {sorted(missing)}"
        )
    return [by_type[name] for name in STEM_NAMES]


def _read_cached_stems(output_directory: Path) -> list[Stem] | None:
    stems: list[Stem] = []
    for stem_name in STEM_NAMES:
        output_path = output_directory / f"{stem_name}.wav"
        if not output_path.is_file():
            return None
        try:
            with wave.open(str(output_path), "rb") as audio:
                if (
                    audio.getframerate() != 44_100
                    or audio.getnchannels() != 2
                    or audio.getsampwidth() != 3
                ):
                    return None
        except (EOFError, wave.Error):
            return None
        stems.append(
            Stem(
                type=stem_name,
                cachePath=str(output_path.resolve()),
                sha256=_sha256(output_path),
            )
        )
    return stems


def _maintain_stem_cache(output_directory: Path) -> None:
    stems_root = output_directory.parent.parent
    if stems_root.name != "stems":
        return
    prune_cache_entries(
        stems_root.parent,
        active_stem_version=output_directory.parent.name,
        kinds={"stems"},
        protected_paths={output_directory},
    )


def separate_sources(
    analysis_audio: Path,
    output_directory: Path,
    model_directory: Path | None = None,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[int, int], None] | None = None,
) -> list[Stem]:
    _check_cancelled(cancel_check)
    cached = _read_cached_stems(output_directory)
    if cached is not None:
        mark_cache_entry_used(output_directory)
        _maintain_stem_cache(output_directory)
        return cached

    import torch
    import torchaudio
    import soundfile

    repository = model_directory or configured_stem_model_directory()
    profile = _stem_profile_for_directory(repository)
    if profile is None:
        raise ValueError(f"未対応の分離モデル構成です: {repository}")
    _check_cancelled(cancel_check)
    log_backend_event(
        "stem-separation",
        f"separation_started audio={analysis_audio} model={repository}",
    )
    waveform, sample_rate = torchaudio.load(str(analysis_audio))
    _check_cancelled(cancel_check)
    waveform = _convert_audio(waveform, sample_rate)
    original_length = waveform.shape[-1]
    log_backend_event(
        "stem-separation",
        (
            f"audio_loaded sample_rate={sample_rate} channels={waveform.shape[0]} "
            f"frames={original_length}"
        ),
    )
    reference = waveform.mean(0)
    reference_std = reference.std()
    if not torch.isfinite(reference_std) or reference_std <= 1e-8:
        raise ValueError("無音の音源は分離できません")

    separated = _separate_with_fallback(
        torch,
        repository,
        waveform,
        cancel_check=cancel_check,
        progress_callback=progress_callback,
    )

    _check_cancelled(cancel_check)
    separated = separated[..., :original_length]
    by_name = _separated_stems_by_name(
        separated,
        profile.source_order,
    )

    output_directory.mkdir(parents=True, exist_ok=True)
    stems: list[Stem] = []
    for stem_name in STEM_NAMES:
        _check_cancelled(cancel_check)
        output_path = output_directory / f"{stem_name}.wav"
        audio = (
            by_name[stem_name]
            .clamp(-1, 1)
            .transpose(0, 1)
            .contiguous()
            .cpu()
            .numpy()
        )
        soundfile.write(
            str(output_path),
            audio,
            STEM_SAMPLE_RATE,
            subtype="PCM_24",
        )
        log_backend_event(
            "stem-separation",
            f"stem_written name={stem_name} path={output_path}",
        )
        stems.append(
            Stem(
                type=stem_name,
                cachePath=str(output_path.resolve()),
                sha256=_sha256(output_path),
            )
        )
    _check_cancelled(cancel_check)
    log_backend_event("stem-separation", "separation_completed")
    _maintain_stem_cache(output_directory)
    return stems


def mix_stems_for_transcription(
    source_paths: list[Path],
    output_path: Path,
    cancel_check: Callable[[], bool] | None = None,
    *,
    gains: list[float] | None = None,
) -> Path:
    if not source_paths:
        raise ValueError("採譜用に合成するステムがありません")
    if gains is None:
        gains = [1.0] * len(source_paths)
    if (
        len(gains) != len(source_paths)
        or any(not math.isfinite(gain) or gain < 0 for gain in gains)
    ):
        raise ValueError("採譜用ステムのゲインが不正です")

    import numpy
    import soundfile

    _check_cancelled(cancel_check)
    infos = [soundfile.info(str(path)) for path in source_paths]
    reference = infos[0]
    for path, info in zip(source_paths[1:], infos[1:], strict=True):
        if (
            info.samplerate != reference.samplerate
            or info.channels != reference.channels
            or info.frames != reference.frames
        ):
            raise ValueError(
                "採譜用ステムの音声形式が一致しません: "
                f"{source_paths[0]} / {path}"
            )

    if output_path.is_file():
        try:
            cached = soundfile.info(str(output_path))
            if (
                cached.format == "WAV"
                and cached.subtype == "FLOAT"
                and cached.samplerate == reference.samplerate
                and cached.channels == reference.channels
                and cached.frames == reference.frames
            ):
                return output_path
        except RuntimeError:
            pass

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(
        f".{output_path.name}.{os.getpid()}.tmp"
    )
    try:
        with ExitStack() as stack:
            sources = [
                stack.enter_context(soundfile.SoundFile(str(path), "r"))
                for path in source_paths
            ]
            target = stack.enter_context(
                soundfile.SoundFile(
                    str(temporary_path),
                    "w",
                    samplerate=reference.samplerate,
                    channels=reference.channels,
                    format="WAV",
                    subtype="FLOAT",
                )
            )
            while True:
                _check_cancelled(cancel_check)
                blocks = [
                    source.read(
                        frames=65_536,
                        dtype="float32",
                        always_2d=True,
                    )
                    for source in sources
                ]
                if not blocks[0].size:
                    break
                if any(block.shape != blocks[0].shape for block in blocks[1:]):
                    raise ValueError("採譜用ステムのフレーム数が一致しません")
                mixed = numpy.sum(
                    numpy.stack(
                        [
                            block * gain
                            for block, gain in zip(blocks, gains, strict=True)
                        ],
                        axis=0,
                    ),
                    axis=0,
                    dtype=numpy.float32,
                )
                if not numpy.isfinite(mixed).all():
                    raise ValueError("採譜用ステムに不正な音声値があります")
                target.write(mixed)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    _check_cancelled(cancel_check)
    log_backend_event(
        "stem-mix",
        (
            f"written path={output_path} sources="
            f"{','.join(path.name for path in source_paths)} "
            f"gains={','.join(f'{gain:.6f}' for gain in gains)}"
        ),
    )
    return output_path


def mix_bass_with_highpassed_drums_for_transcription(
    bass_path: Path,
    drums_path: Path,
    guide_gain: float,
    output_path: Path,
    cancel_check: Callable[[], bool] | None = None,
    *,
    cutoff_hz: float = BASS_DRUM_GUIDE_HIGHPASS_HZ,
) -> Path:
    if not math.isfinite(guide_gain) or not 0.0 <= guide_gain <= 1.0:
        raise ValueError("Bass用ドラム補助音のゲインが不正です")
    if not math.isfinite(cutoff_hz) or cutoff_hz <= 0.0:
        raise ValueError("Bass用ドラム補助音のカットオフ周波数が不正です")

    import numpy
    import soundfile
    from scipy.signal import butter, sosfilt, sosfilt_zi

    _check_cancelled(cancel_check)
    bass_info = soundfile.info(str(bass_path))
    drums_info = soundfile.info(str(drums_path))
    if (
        drums_info.samplerate != bass_info.samplerate
        or drums_info.channels != bass_info.channels
        or drums_info.frames != bass_info.frames
    ):
        raise ValueError(
            "Bassとドラムの音声形式が一致しません: "
            f"{bass_path} / {drums_path}"
        )
    if cutoff_hz >= bass_info.samplerate / 2:
        raise ValueError("Bass用ドラム補助音のカットオフ周波数が不正です")

    if output_path.is_file():
        try:
            cached = soundfile.info(str(output_path))
            if (
                cached.format == "WAV"
                and cached.subtype == "FLOAT"
                and cached.samplerate == bass_info.samplerate
                and cached.channels == bass_info.channels
                and cached.frames == bass_info.frames
            ):
                return output_path
        except RuntimeError:
            pass

    filter_sections = butter(
        BASS_DRUM_GUIDE_FILTER_ORDER,
        cutoff_hz,
        btype="highpass",
        fs=bass_info.samplerate,
        output="sos",
    )
    initial_state = sosfilt_zi(filter_sections)[:, :, numpy.newaxis]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(
        f".{output_path.name}.{os.getpid()}.tmp"
    )
    filter_state = None
    try:
        with ExitStack() as stack:
            bass_source = stack.enter_context(
                soundfile.SoundFile(str(bass_path), "r")
            )
            drums_source = stack.enter_context(
                soundfile.SoundFile(str(drums_path), "r")
            )
            target = stack.enter_context(
                soundfile.SoundFile(
                    str(temporary_path),
                    "w",
                    samplerate=bass_info.samplerate,
                    channels=bass_info.channels,
                    format="WAV",
                    subtype="FLOAT",
                )
            )
            while True:
                _check_cancelled(cancel_check)
                bass = bass_source.read(
                    frames=65_536,
                    dtype="float32",
                    always_2d=True,
                )
                drums = drums_source.read(
                    frames=65_536,
                    dtype="float32",
                    always_2d=True,
                )
                if not bass.size:
                    if drums.size:
                        raise ValueError("Bassとドラムのフレーム数が一致しません")
                    break
                if bass.shape != drums.shape:
                    raise ValueError("Bassとドラムのフレーム数が一致しません")
                if filter_state is None:
                    filter_state = initial_state * drums[0][numpy.newaxis, None, :]
                filtered_drums, filter_state = sosfilt(
                    filter_sections,
                    drums,
                    axis=0,
                    zi=filter_state,
                )
                mixed = bass + filtered_drums.astype(numpy.float32) * guide_gain
                if not numpy.isfinite(mixed).all():
                    raise ValueError("Bass用ドラム補助音に不正な音声値があります")
                target.write(mixed)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    _check_cancelled(cancel_check)
    log_backend_event(
        "stem-separation",
        (
            "bass_timing_guide_written "
            f"cutoff_hz={cutoff_hz:g} "
            f"gain={guide_gain:g} output={output_path}"
        ),
    )
    return output_path


def export_stems(stems: list[Stem], output_directory: Path, project_name: str) -> list[Path]:
    import shutil

    direct_stems = separation_output_stems(stems)
    safe_name = "".join(
        "_" if character in '<>:"/\\|?*' else character
        for character in project_name
    ).strip(" .")
    if not safe_name:
        safe_name = "score"
    output_directory.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []
    for stem in direct_stems:
        source = Path(stem.cache_path)
        if not source.is_file() or _sha256(source) != stem.sha256:
            raise ValueError(f"ステムキャッシュが不正です: {source}")
        destination = output_directory / f"{safe_name}_{stem.type}.wav"
        shutil.copy2(source, destination)
        outputs.append(destination)
    return outputs
