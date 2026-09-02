from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

from .model_validation import ModelVariant

TranscriptionProfile = Literal["high_accuracy", "fast"]
InferenceDevice = Literal["CPU", "CUDA"]


@dataclass(frozen=True, slots=True)
class TranscriptionInferenceSettings:
    prelude_forcing: bool
    batch_size: int


HIGH_ACCURACY_INFERENCE_SETTINGS: Final = TranscriptionInferenceSettings(
    prelude_forcing=True,
    batch_size=1,
)
FAST_CPU_INFERENCE_SETTINGS: Final = TranscriptionInferenceSettings(
    prelude_forcing=False,
    batch_size=1,
)


def fast_cuda_batch_size(model_variant: ModelVariant) -> int:
    if model_variant == "large":
        return 2
    if model_variant == "medium":
        return 8
    if model_variant == "small":
        return 16
    raise ValueError(f"未対応のMuScriptorモデルです: {model_variant}")


def inference_settings_for_profile(
    profile: TranscriptionProfile,
    model_variant: ModelVariant,
    device: InferenceDevice,
) -> TranscriptionInferenceSettings:
    if profile == "high_accuracy":
        return HIGH_ACCURACY_INFERENCE_SETTINGS
    if profile == "fast":
        if device == "CPU":
            return FAST_CPU_INFERENCE_SETTINGS
        return TranscriptionInferenceSettings(
            prelude_forcing=False,
            batch_size=fast_cuda_batch_size(model_variant),
        )
    raise ValueError(f"未対応の採譜モードです: {profile}")
