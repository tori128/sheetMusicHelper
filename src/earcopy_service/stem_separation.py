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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Mapping

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
TRANSCRIPTION_ROUTING_VERSION: Final = "bs-roformer-config-v1"
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
BS_ROFORMER_MODEL_ROOT: Final = Path("models") / "bs-roformer"
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
    model_options: Mapping[str, Any] = field(default_factory=dict)
    model_size_bytes: int | None = None
    configuration_path: Path | None = None
    cache_token: str = ""

    @property
    def cache_version(self) -> str:
        if self.model_sha256:
            return f"{self.key}-{self.model_sha256[:12]}"
        if self.cache_token:
            return f"{self.key}-{self.cache_token}"
        if self.model_size_bytes is None:
            return self.key
        return f"{self.key}-{self.model_size_bytes}"


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
    relative_directory=BS_ROFORMER_MODEL_ROOT / "sw-fixed",
    model_file=BS_ROFORMER_SW_MODEL_FILE,
    model_sha256=BS_ROFORMER_SW_MODEL_SHA256,
    source_order=BS_ROFORMER_SW_SOURCE_ORDER,
    num_stems=6,
    segment_samples=588_800,
    num_overlap=2,
    batch_size=1,
    attention_dropout=0.1,
    feed_forward_dropout=0.1,
    model_options={
        "dimension": 256,
        "depth": 12,
        "stereo": True,
        "num_stems": 6,
        "time_transformer_depth": 1,
        "frequency_transformer_depth": 1,
        "linear_transformer_depth": 0,
        "head_dimension": 64,
        "heads": 8,
        "attention_dropout": 0.1,
        "feed_forward_dropout": 0.1,
        "flash_attention": True,
        "stft_n_fft": 2048,
        "stft_hop_length": 512,
        "stft_win_length": 2048,
        "stft_normalized": False,
        "mask_estimator_depth": 2,
        "mlp_expansion_factor": 4,
        "skip_connection": False,
    },
    model_size_bytes=BS_ROFORMER_SW_MODEL_SIZE_BYTES,
)
BS_ROFORMER_SW_DISTRIBUTION: Final = StemModelDistribution(
    source_page_url=(
        "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/tree/main"
    ),
    download_url=(
        "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/main/"
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


def _stem_model_candidates() -> list[Path]:
    configured = os.getenv("EARCOPY_STEM_MODEL_DIR")
    if configured:
        configured_path = Path(configured)
        if configured_path.name.casefold() == "bs-roformer":
            root = configured_path
        elif configured_path.parent.name.casefold() == "bs-roformer":
            return [configured_path]
        else:
            root = configured_path / "bs-roformer"
    else:
        root = BS_ROFORMER_MODEL_ROOT

    if not root.is_dir():
        return [root / "sw-fixed"]
    candidates = sorted(
        (path for path in root.iterdir() if path.is_dir()),
        key=lambda path: (path.name.casefold() != "sw-fixed", path.name.casefold()),
    )
    return candidates or [root / "sw-fixed"]


def _configuration_paths(model_directory: Path, model_path: Path) -> list[Path]:
    matching = [
        model_directory / f"{model_path.stem}.yaml",
        model_directory / f"{model_path.stem}.yml",
    ]
    return [path for path in matching if path.is_file()] or sorted(
        [
            *model_directory.glob("*.yaml"),
            *model_directory.glob("*.yml"),
        ]
    )


def _configuration_value(
    values: Mapping[str, Any],
    key: str,
    expected_type: type,
    default: Any = None,
) -> Any:
    value = values.get(key, default)
    if not isinstance(value, expected_type):
        raise ValueError(f"BS-RoFormer構成の{key}が不正です")
    return value


def _external_stem_profile(model_directory: Path) -> StemModelProfile | None:
    model_paths = sorted(
        [
            *model_directory.glob("*.ckpt"),
            *model_directory.glob("*.pt"),
            *model_directory.glob("*.pth"),
        ]
    )
    if not model_paths:
        return None
    if len(model_paths) != 1:
        raise ValueError(
            "BS-RoFormerモデルフォルダーには重みファイルを1件だけ配置してください: "
            f"{model_directory}"
        )
    model_path = model_paths[0]
    configuration_paths = _configuration_paths(model_directory, model_path)
    if len(configuration_paths) != 1:
        raise ValueError(
            "別のBS-RoFormer重みには同じフォルダー内のYAML構成ファイルが必要です: "
            f"{model_directory}"
        )

    import yaml

    class ConfigurationLoader(yaml.SafeLoader):
        pass

    ConfigurationLoader.add_constructor(
        "tag:yaml.org,2002:python/tuple",
        lambda loader, node: tuple(loader.construct_sequence(node)),
    )
    configuration_path = configuration_paths[0]
    try:
        with configuration_path.open(encoding="utf-8") as source:
            configuration = yaml.load(source, Loader=ConfigurationLoader)
    except yaml.YAMLError as exc:
        raise ValueError(
            f"BS-RoFormer構成ファイルを読み取れません: {configuration_path}"
        ) from exc
    if not isinstance(configuration, Mapping):
        raise ValueError(f"BS-RoFormer構成が辞書形式ではありません: {configuration_path}")
    model = configuration.get("model")
    audio = configuration.get("audio")
    training = configuration.get("training")
    inference = configuration.get("inference")
    if not all(
        isinstance(section, Mapping)
        for section in (model, audio, training, inference)
    ):
        raise ValueError(
            "BS-RoFormer構成にはmodel、audio、training、inferenceが必要です"
        )
    if _configuration_value(audio, "sample_rate", int) != STEM_SAMPLE_RATE:
        raise ValueError("44.1 kHz以外のBS-RoFormer構成には対応していません")
    if _configuration_value(audio, "num_channels", int) != 2:
        raise ValueError("モノラルのBS-RoFormer構成には対応していません")
    if _configuration_value(model, "stereo", bool) is not True:
        raise ValueError("ステレオのBS-RoFormer構成が必要です")
    if _configuration_value(model, "linear_transformer_depth", int, 0) != 0:
        raise ValueError("linear_transformer_depthが1以上の構成には対応していません")

    source_order = tuple(
        item.casefold()
        for item in _configuration_value(training, "instruments", (list, tuple))
        if isinstance(item, str)
    )
    if (
        not source_order
        or len(source_order) != len(set(source_order))
        or any(source not in STEM_NAMES for source in source_order)
    ):
        raise ValueError(
            "BS-RoFormer構成のtraining.instrumentsには重複しない標準成分名が必要です"
        )
    num_stems = _configuration_value(model, "num_stems", int)
    if num_stems != len(source_order):
        raise ValueError(
            "BS-RoFormer構成のnum_stemsとtraining.instrumentsの件数が一致しません"
        )

    freqs_per_bands = _configuration_value(model, "freqs_per_bands", (list, tuple))
    if not all(isinstance(value, int) and value > 0 for value in freqs_per_bands):
        raise ValueError("BS-RoFormer構成のfreqs_per_bandsが不正です")
    model_options = {
        "dimension": _configuration_value(model, "dim", int),
        "depth": _configuration_value(model, "depth", int),
        "stereo": True,
        "num_stems": num_stems,
        "time_transformer_depth": _configuration_value(
            model, "time_transformer_depth", int
        ),
        "frequency_transformer_depth": _configuration_value(
            model, "freq_transformer_depth", int
        ),
        "linear_transformer_depth": 0,
        "freqs_per_bands": tuple(freqs_per_bands),
        "head_dimension": _configuration_value(model, "dim_head", int),
        "heads": _configuration_value(model, "heads", int),
        "attention_dropout": _configuration_value(model, "attn_dropout", (int, float)),
        "feed_forward_dropout": _configuration_value(model, "ff_dropout", (int, float)),
        "flash_attention": _configuration_value(model, "flash_attn", bool),
        "stft_n_fft": _configuration_value(model, "stft_n_fft", int),
        "stft_hop_length": _configuration_value(model, "stft_hop_length", int),
        "stft_win_length": _configuration_value(model, "stft_win_length", int),
        "stft_normalized": _configuration_value(model, "stft_normalized", bool),
        "mask_estimator_depth": _configuration_value(model, "mask_estimator_depth", int),
        "mlp_expansion_factor": _configuration_value(model, "mlp_expansion_factor", int),
        "skip_connection": _configuration_value(model, "skip_connection", bool, False),
    }
    model_stat = model_path.stat()
    configuration_stat = configuration_path.stat()
    cache_token = hashlib.sha256(
        (
            f"{model_stat.st_size}:"
            f"{model_stat.st_mtime_ns}:"
            f"{configuration_stat.st_mtime_ns}"
        ).encode()
    ).hexdigest()[:12]
    return StemModelProfile(
        key=f"bs-roformer-{model_directory.name.casefold()}",
        display_name=f"BS-RoFormer {model_path.stem}",
        relative_directory=model_directory,
        model_file=model_path.name,
        model_sha256="",
        source_order=source_order,
        num_stems=num_stems,
        segment_samples=_configuration_value(audio, "chunk_size", int),
        num_overlap=_configuration_value(inference, "num_overlap", int),
        batch_size=_configuration_value(inference, "batch_size", int),
        attention_dropout=float(model_options["attention_dropout"]),
        feed_forward_dropout=float(model_options["feed_forward_dropout"]),
        model_options=model_options,
        model_size_bytes=model_stat.st_size,
        configuration_path=configuration_path,
        cache_token=cache_token,
    )


def _stem_profile_for_directory(
    model_directory: Path,
) -> StemModelProfile | None:
    default_path = model_directory / BS_ROFORMER_SW_MODEL_FILE
    if default_path.is_file() and not _configuration_paths(
        model_directory, default_path
    ):
        return BS_ROFORMER_SW_PROFILE
    return _external_stem_profile(model_directory)


def configured_stem_model() -> tuple[Path, StemModelProfile]:
    candidates = _stem_model_candidates()
    configuration_errors: list[str] = []
    for candidate in candidates:
        try:
            profile = _stem_profile_for_directory(candidate)
        except ValueError as exc:
            configuration_errors.append(str(exc))
            continue
        if profile is not None:
            return candidate.resolve(), profile
    expectations = [str(candidate.resolve(strict=False)) for candidate in candidates]
    detail = " / ".join(configuration_errors)
    raise FileNotFoundError(
        "音源分離モデルが見つかりません。配置先: "
        + " / ".join(expectations)
        + (f"。{detail}" if detail else "")
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
        model_path = model_directory / profile.model_file
        status = {
            **common,
            "available": True,
            "modelDirectory": str(model_directory),
            "modelName": profile.display_name,
            "modelFileName": profile.model_file,
            "modelSizeBytes": model_path.stat().st_size,
            "modelSha256": profile.model_sha256,
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
    if not profile.model_sha256:
        return model_path
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

    model = BSRoformer(**profile.model_options)

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
    unexpected = set(by_name) - set(STEM_NAMES)
    if unexpected:
        raise ValueError(
            f"分離結果に未対応の成分があります: {sorted(unexpected)}"
        )
    return {name: by_name[name] for name in STEM_NAMES if name in by_name}


def separation_output_stems(stems: list[Stem]) -> list[Stem]:
    by_type = {stem.type: stem for stem in stems}
    return [by_type[name] for name in STEM_NAMES if name in by_type]


def _read_cached_stems(
    output_directory: Path,
    source_order: tuple[str, ...] = STEM_NAMES,
) -> list[Stem] | None:
    stems: list[Stem] = []
    for stem_name in source_order:
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
    repository = model_directory or configured_stem_model_directory()
    profile = _stem_profile_for_directory(repository)
    if profile is None:
        raise ValueError(f"未対応の分離モデル構成です: {repository}")
    cached = _read_cached_stems(output_directory, profile.source_order)
    if cached is not None:
        mark_cache_entry_used(output_directory)
        _maintain_stem_cache(output_directory)
        return cached

    import torch
    import torchaudio
    import soundfile

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
    for stem_name in profile.source_order:
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
