from __future__ import annotations

import gc
import hashlib
import os
import wave
from pathlib import Path
from typing import Any, Final

from .models import Stem

STEM_NAMES: Final = ("drums", "bass", "vocals", "other")
SCNET_MODEL_FILE: Final = "SCNet-large.th"
SCNET_CONFIG_FILE: Final = "config.yaml"
SCNET_MODEL_SHA256: Final = (
    "719e5abb8ed920305dad546ac3cd6fb0b1e9c3092d14ce21827bfc0423af3070"
)
SCNET_CONFIG_SHA256: Final = (
    "629a4901184bf1d3a75b0b13904f35974785aa042cad3c010fd576248cdce3f0"
)
SCNET_CACHE_VERSION: Final = f"scnet-large-{SCNET_MODEL_SHA256[:12]}"
SCNET_SOURCE_ORDER: Final = ("drums", "bass", "other", "vocals")
SCNET_SAMPLE_RATE: Final = 44_100


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configured_scnet_model_directory() -> Path:
    configured = os.getenv("EARCOPY_SCNET_MODEL_DIR")
    candidates = [
        Path(configured) if configured else None,
        Path("models") / "scnet" / "large",
    ]
    for candidate in candidates:
        if (
            candidate is not None
            and (candidate / SCNET_MODEL_FILE).is_file()
            and (candidate / SCNET_CONFIG_FILE).is_file()
        ):
            return candidate.resolve()
    raise FileNotFoundError(
        "SCNet Largeモデルが見つかりません: "
        f"{SCNET_MODEL_FILE}, {SCNET_CONFIG_FILE}"
    )


def validate_scnet_model(model_directory: Path) -> tuple[Path, Path]:
    model_path = model_directory / SCNET_MODEL_FILE
    if not model_path.is_file():
        raise FileNotFoundError(f"SCNet Largeモデルが見つかりません: {model_path}")
    config_path = model_directory / SCNET_CONFIG_FILE
    if not config_path.is_file():
        raise FileNotFoundError(f"SCNet Large設定が見つかりません: {config_path}")
    actual_model = _sha256(model_path)
    if actual_model != SCNET_MODEL_SHA256:
        raise ValueError(
            "SCNet LargeモデルのSHA-256が一致しません: "
            f"expected={SCNET_MODEL_SHA256}, actual={actual_model}"
        )
    actual_config = _sha256(config_path)
    if actual_config != SCNET_CONFIG_SHA256:
        raise ValueError(
            "SCNet Large設定のSHA-256が一致しません: "
            f"expected={SCNET_CONFIG_SHA256}, actual={actual_config}"
        )
    return model_path, config_path


def _load_scnet_model(
    model_directory: Path,
    device: Any | None = None,
) -> tuple[Any, float]:
    import torch
    import yaml

    from ._vendor.scnet import SCNet

    model_path, config_path = validate_scnet_model(model_directory)
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or not isinstance(config.get("model"), dict):
        raise ValueError("SCNet Large設定にmodelセクションがありません")
    model_config = config["model"]
    if tuple(model_config.get("sources", ())) != SCNET_SOURCE_ORDER:
        raise ValueError(
            f"未対応のSCNetステム構成です: {model_config.get('sources')}"
        )
    if model_config.get("audio_channels") != 2:
        raise ValueError("SCNet Largeはstereo設定である必要があります")

    model = SCNet(**model_config)
    checkpoint = torch.load(
        model_path,
        map_location=torch.device("cpu"),
        weights_only=True,
    )
    if not isinstance(checkpoint, dict) or not isinstance(
        checkpoint.get("best_state"), dict
    ):
        raise ValueError("SCNet Largeチェックポイントにbest_stateがありません")
    state = {
        key.removeprefix("module."): value
        for key, value in checkpoint["best_state"].items()
    }
    model.load_state_dict(state, strict=True)
    model.to(device or torch.device("cpu"))
    model.eval()

    data_config = config.get("data", {})
    segment_seconds = float(data_config.get("segment", 11))
    if not 1 <= segment_seconds <= 60:
        raise ValueError(f"SCNetのsegment設定が不正です: {segment_seconds}")
    return model, segment_seconds


def _convert_audio(waveform: Any, sample_rate: int) -> Any:
    import torchaudio

    if waveform.ndim != 2 or waveform.shape[0] < 1:
        raise ValueError(f"音声テンソルの形状が不正です: {waveform.shape}")
    if waveform.shape[0] == 1:
        waveform = waveform.expand(2, -1)
    elif waveform.shape[0] > 2:
        waveform = waveform[:2]
    if sample_rate != SCNET_SAMPLE_RATE:
        waveform = torchaudio.functional.resample(
            waveform,
            sample_rate,
            SCNET_SAMPLE_RATE,
        )
    return waveform


def _apply_scnet_model(
    model: Any,
    waveform: Any,
    segment_seconds: float,
    device: Any | None = None,
) -> Any:
    import torch

    inference_device = torch.device(device) if device is not None else waveform.device
    segment = max(1, round(SCNET_SAMPLE_RATE * segment_seconds))
    stride = max(1, segment // 2)
    length = waveform.shape[-1]
    output = torch.zeros(
        1,
        len(SCNET_SOURCE_ORDER),
        2,
        length,
        dtype=waveform.dtype,
    )
    weight_sum = torch.zeros(length, dtype=waveform.dtype)
    weight = torch.cat(
        (
            torch.arange(1, segment // 2 + 1, dtype=waveform.dtype),
            torch.arange(
                segment - segment // 2,
                0,
                -1,
                dtype=waveform.dtype,
            ),
        )
    )
    weight /= weight.max()

    with torch.inference_mode():
        for offset in range(0, length, stride):
            chunk = waveform[..., offset : offset + segment]
            chunk_length = chunk.shape[-1]
            estimate = (
                model(chunk.to(inference_device)[None])[..., :chunk_length]
                .to(waveform.device)
            )
            chunk_weight = weight[:chunk_length]
            output[..., offset : offset + chunk_length] += (
                estimate * chunk_weight
            )
            weight_sum[offset : offset + chunk_length] += chunk_weight

    if weight_sum.min() <= 0:
        raise RuntimeError("SCNetの分離結果を結合できませんでした")
    return output[0] / weight_sum


def _separate_with_device(
    repository: Path,
    normalized: Any,
    device: Any,
) -> Any:
    model, segment_seconds = _load_scnet_model(repository, device)
    return _apply_scnet_model(
        model,
        normalized,
        segment_seconds,
        device=device,
    )


def _release_cuda_memory(torch: Any) -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _separate_with_fallback(
    torch: Any,
    repository: Path,
    normalized: Any,
) -> Any:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    try:
        return _separate_with_device(repository, normalized, device)
    except torch.cuda.OutOfMemoryError:
        if device.type != "cuda":
            raise
        _release_cuda_memory(torch)
        return _separate_with_device(
            repository,
            normalized,
            torch.device("cpu"),
        )
    finally:
        if device.type == "cuda":
            _release_cuda_memory(torch)


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


def separate_four_stems(
    analysis_audio: Path,
    output_directory: Path,
    model_directory: Path | None = None,
) -> list[Stem]:
    cached = _read_cached_stems(output_directory)
    if cached is not None:
        return cached

    import torch
    import torchaudio
    import soundfile

    repository = model_directory or configured_scnet_model_directory()
    waveform, sample_rate = torchaudio.load(str(analysis_audio))
    waveform = _convert_audio(waveform, sample_rate)
    original_length = waveform.shape[-1]
    reference = waveform.mean(0)
    reference_mean = reference.mean()
    reference_std = reference.std()
    if not torch.isfinite(reference_std) or reference_std <= 1e-8:
        raise ValueError("無音の音源は4ステムへ分離できません")
    normalized = (waveform - reference_mean) / reference_std

    separated = _separate_with_fallback(torch, repository, normalized)

    separated = separated[..., :original_length]
    separated = separated * reference_std + reference_mean

    output_directory.mkdir(parents=True, exist_ok=True)
    by_name = dict(zip(SCNET_SOURCE_ORDER, separated, strict=True))
    stems: list[Stem] = []
    for stem_name in STEM_NAMES:
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
            SCNET_SAMPLE_RATE,
            subtype="PCM_24",
        )
        stems.append(
            Stem(
                type=stem_name,
                cachePath=str(output_path.resolve()),
                sha256=_sha256(output_path),
            )
        )
    return stems


def export_stems(stems: list[Stem], output_directory: Path, project_name: str) -> list[Path]:
    import shutil

    by_type = {stem.type: stem for stem in stems}
    missing = set(STEM_NAMES) - set(by_type)
    if missing:
        raise ValueError(f"出力できないステムがあります: {sorted(missing)}")
    safe_name = "".join(
        "_" if character in '<>:"/\\|?*' else character
        for character in project_name
    ).strip(" .")
    if not safe_name:
        safe_name = "score"
    output_directory.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []
    for stem_name in STEM_NAMES:
        source = Path(by_type[stem_name].cache_path)
        if not source.is_file() or _sha256(source) != by_type[stem_name].sha256:
            raise ValueError(f"ステムキャッシュが不正です: {source}")
        destination = output_directory / f"{safe_name}_{stem_name}.wav"
        shutil.copy2(source, destination)
        outputs.append(destination)
    return outputs
