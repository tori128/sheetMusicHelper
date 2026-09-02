from __future__ import annotations

import os
from collections import namedtuple
from functools import partial, wraps
from typing import Callable

import torch
import torch.nn.functional as functional
from einops import pack, rearrange, unpack
from einops.layers.torch import Rearrange
from packaging import version
from rotary_embedding_torch import RotaryEmbedding
from torch import Tensor, einsum, nn
from torch.nn import Module, ModuleList


def _exists(value: object | None) -> bool:
    return value is not None


def _default(value: object | None, fallback: object) -> object:
    return value if _exists(value) else fallback


def _pack_one(value: Tensor, pattern: str) -> tuple[Tensor, list]:
    return pack([value], pattern)


def _unpack_one(value: Tensor, packed_shape: list, pattern: str) -> Tensor:
    return unpack(value, packed_shape, pattern)[0]


def _once(function: Callable) -> Callable:
    called = False

    @wraps(function)
    def inner(value: str) -> None:
        nonlocal called
        if called:
            return
        called = True
        function(value)

    return inner


_print_once = _once(print)
_FlashAttentionConfig = namedtuple(
    "_FlashAttentionConfig",
    ["enable_flash", "enable_math", "enable_mem_efficient"],
)


class Attend(Module):
    def __init__(
        self,
        dropout: float = 0.0,
        flash: bool = False,
        scale: float | None = None,
    ) -> None:
        super().__init__()
        self.scale = scale
        self.dropout = dropout
        self.attn_dropout = nn.Dropout(dropout)
        self.flash = flash
        if flash and version.parse(torch.__version__) < version.parse("2.0.0"):
            raise ValueError("Flash attention requires PyTorch 2.0 or newer")

        self.cpu_config = _FlashAttentionConfig(True, True, True)
        self.cuda_config = None
        if not torch.cuda.is_available() or not flash:
            return

        properties = torch.cuda.get_device_properties(torch.device("cuda"))
        device_version = version.parse(
            f"{properties.major}.{properties.minor}"
        )
        if device_version >= version.parse("8.0") and os.name != "nt":
            self.cuda_config = _FlashAttentionConfig(True, False, False)
        else:
            if os.name == "nt":
                _print_once(
                    "Windows: using math or memory-efficient attention"
                )
            self.cuda_config = _FlashAttentionConfig(False, True, True)

    def _flash_attention(
        self,
        queries: Tensor,
        keys: Tensor,
        values: Tensor,
    ) -> Tensor:
        if self.scale is not None:
            default_scale = queries.shape[-1] ** -0.5
            queries = queries * (self.scale / default_scale)
        config = self.cuda_config if queries.is_cuda else self.cpu_config
        with torch.backends.cuda.sdp_kernel(**config._asdict()):
            return functional.scaled_dot_product_attention(
                queries,
                keys,
                values,
                dropout_p=self.dropout if self.training else 0.0,
            )

    def forward(
        self,
        queries: Tensor,
        keys: Tensor,
        values: Tensor,
    ) -> Tensor:
        if self.flash:
            return self._flash_attention(queries, keys, values)
        scale = self.scale or queries.shape[-1] ** -0.5
        similarity = einsum(
            "b h i d, b h j d -> b h i j",
            queries,
            keys,
        ) * scale
        attention = self.attn_dropout(similarity.softmax(dim=-1))
        return einsum(
            "b h i j, b h j d -> b h i d",
            attention,
            values,
        )


class RMSNorm(Module):
    def __init__(self, dimension: int) -> None:
        super().__init__()
        self.scale = dimension**0.5
        self.gamma = nn.Parameter(torch.ones(dimension))

    def forward(self, value: Tensor) -> Tensor:
        return (
            functional.normalize(value, dim=-1)
            * self.scale
            * self.gamma
        )


class FeedForward(Module):
    def __init__(
        self,
        dimension: int,
        multiplier: int = 4,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        inner_dimension = int(dimension * multiplier)
        self.net = nn.Sequential(
            RMSNorm(dimension),
            nn.Linear(dimension, inner_dimension),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(inner_dimension, dimension),
            nn.Dropout(dropout),
        )

    def forward(self, value: Tensor) -> Tensor:
        return self.net(value)


class Attention(Module):
    def __init__(
        self,
        dimension: int,
        heads: int = 8,
        head_dimension: int = 64,
        dropout: float = 0.0,
        rotary_embedding: RotaryEmbedding | None = None,
        flash: bool = True,
    ) -> None:
        super().__init__()
        self.heads = heads
        inner_dimension = heads * head_dimension
        self.rotary_embed = rotary_embedding
        self.attend = Attend(flash=flash, dropout=dropout)
        self.norm = RMSNorm(dimension)
        self.to_qkv = nn.Linear(
            dimension,
            inner_dimension * 3,
            bias=False,
        )
        self.to_gates = nn.Linear(dimension, heads)
        self.to_out = nn.Sequential(
            nn.Linear(inner_dimension, dimension, bias=False),
            nn.Dropout(dropout),
        )

    def forward(self, value: Tensor) -> Tensor:
        value = self.norm(value)
        queries, keys, values = rearrange(
            self.to_qkv(value),
            "b n (qkv h d) -> qkv b h n d",
            qkv=3,
            h=self.heads,
        )
        if self.rotary_embed is not None:
            queries = self.rotary_embed.rotate_queries_or_keys(queries)
            keys = self.rotary_embed.rotate_queries_or_keys(keys)
        output = self.attend(queries, keys, values)
        gates = self.to_gates(value)
        output = output * rearrange(
            gates,
            "b n h -> b h n 1",
        ).sigmoid()
        output = rearrange(output, "b h n d -> b n (h d)")
        return self.to_out(output)


class Transformer(Module):
    def __init__(
        self,
        *,
        dimension: int,
        depth: int,
        head_dimension: int = 64,
        heads: int = 8,
        attention_dropout: float = 0.0,
        feed_forward_dropout: float = 0.0,
        feed_forward_multiplier: int = 4,
        normalize_output: bool = True,
        rotary_embedding: RotaryEmbedding | None = None,
        flash_attention: bool = True,
    ) -> None:
        super().__init__()
        self.layers = ModuleList(
            [
                ModuleList(
                    [
                        Attention(
                            dimension=dimension,
                            head_dimension=head_dimension,
                            heads=heads,
                            dropout=attention_dropout,
                            rotary_embedding=rotary_embedding,
                            flash=flash_attention,
                        ),
                        FeedForward(
                            dimension,
                            multiplier=feed_forward_multiplier,
                            dropout=feed_forward_dropout,
                        ),
                    ]
                )
                for _ in range(depth)
            ]
        )
        self.norm = (
            RMSNorm(dimension) if normalize_output else nn.Identity()
        )

    def forward(self, value: Tensor) -> Tensor:
        for attention, feed_forward in self.layers:
            value = attention(value) + value
            value = feed_forward(value) + value
        return self.norm(value)


class BandSplit(Module):
    def __init__(
        self,
        dimension: int,
        input_dimensions: tuple[int, ...],
    ) -> None:
        super().__init__()
        self.dim_inputs = input_dimensions
        self.to_features = ModuleList(
            [
                nn.Sequential(
                    RMSNorm(input_dimension),
                    nn.Linear(input_dimension, dimension),
                )
                for input_dimension in input_dimensions
            ]
        )

    def forward(self, value: Tensor) -> Tensor:
        splits = value.split(self.dim_inputs, dim=-1)
        return torch.stack(
            [
                to_feature(split)
                for split, to_feature in zip(
                    splits,
                    self.to_features,
                    strict=True,
                )
            ],
            dim=-2,
        )


def _mlp(
    input_dimension: int,
    output_dimension: int,
    hidden_dimension: int | None = None,
    depth: int = 1,
) -> nn.Sequential:
    hidden_dimension = hidden_dimension or input_dimension
    dimensions = (
        input_dimension,
        *((hidden_dimension,) * (depth - 1)),
        output_dimension,
    )
    layers: list[Module] = []
    for index, (layer_input, layer_output) in enumerate(
        zip(dimensions[:-1], dimensions[1:], strict=True)
    ):
        layers.append(nn.Linear(layer_input, layer_output))
        if index != len(dimensions) - 2:
            layers.append(nn.Tanh())
    return nn.Sequential(*layers)


class MaskEstimator(Module):
    def __init__(
        self,
        dimension: int,
        input_dimensions: tuple[int, ...],
        depth: int,
        expansion_factor: int = 4,
    ) -> None:
        super().__init__()
        self.dim_inputs = input_dimensions
        hidden_dimension = dimension * expansion_factor
        self.to_freqs = ModuleList(
            [
                nn.Sequential(
                    _mlp(
                        dimension,
                        input_dimension * 2,
                        hidden_dimension=hidden_dimension,
                        depth=depth,
                    ),
                    nn.GLU(dim=-1),
                )
                for input_dimension in input_dimensions
            ]
        )

    def forward(self, value: Tensor) -> Tensor:
        return torch.cat(
            [
                estimator(band_features)
                for band_features, estimator in zip(
                    value.unbind(dim=-2),
                    self.to_freqs,
                    strict=True,
                )
            ],
            dim=-1,
        )


DEFAULT_FREQS_PER_BANDS = (
    *((2,) * 24),
    *((4,) * 12),
    *((12,) * 8),
    *((24,) * 8),
    *((48,) * 8),
    128,
    129,
)


class BSRoformer(Module):
    """Inference-compatible BS-RoFormer from the MSST implementation."""

    def __init__(
        self,
        dimension: int,
        *,
        depth: int,
        stereo: bool = False,
        num_stems: int = 1,
        time_transformer_depth: int = 2,
        frequency_transformer_depth: int = 2,
        linear_transformer_depth: int = 0,
        freqs_per_bands: tuple[int, ...] = DEFAULT_FREQS_PER_BANDS,
        head_dimension: int = 64,
        heads: int = 8,
        attention_dropout: float = 0.0,
        feed_forward_dropout: float = 0.0,
        flash_attention: bool = True,
        stft_n_fft: int = 2048,
        stft_hop_length: int = 512,
        stft_win_length: int = 2048,
        stft_normalized: bool = False,
        zero_dc: bool = True,
        mask_estimator_depth: int = 2,
        mlp_expansion_factor: int = 4,
        skip_connection: bool = False,
    ) -> None:
        super().__init__()
        if linear_transformer_depth:
            raise ValueError(
                "This inference build does not support linear attention"
            )
        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems
        self.skip_connection = skip_connection
        self.layers = ModuleList()

        time_rotary_embedding = RotaryEmbedding(dim=head_dimension)
        frequency_rotary_embedding = RotaryEmbedding(dim=head_dimension)
        transformer_options = {
            "dimension": dimension,
            "heads": heads,
            "head_dimension": head_dimension,
            "attention_dropout": attention_dropout,
            "feed_forward_dropout": feed_forward_dropout,
            "normalize_output": False,
            "flash_attention": flash_attention,
        }
        for _ in range(depth):
            self.layers.append(
                ModuleList(
                    [
                        Transformer(
                            depth=time_transformer_depth,
                            rotary_embedding=time_rotary_embedding,
                            **transformer_options,
                        ),
                        Transformer(
                            depth=frequency_transformer_depth,
                            rotary_embedding=frequency_rotary_embedding,
                            **transformer_options,
                        ),
                    ]
                )
            )

        self.final_norm = RMSNorm(dimension)
        self.stft_kwargs = {
            "n_fft": stft_n_fft,
            "hop_length": stft_hop_length,
            "win_length": stft_win_length,
            "normalized": stft_normalized,
        }
        self.stft_window_fn = partial(
            torch.hann_window,
            stft_win_length,
        )
        frequency_count = torch.stft(
            torch.randn(1, 4096),
            **self.stft_kwargs,
            window=torch.ones(stft_win_length),
            return_complex=True,
        ).shape[1]
        if sum(freqs_per_bands) != frequency_count:
            raise ValueError(
                "Frequency bands do not match the configured STFT: "
                f"{sum(freqs_per_bands)} != {frequency_count}"
            )
        complex_input_dimensions = tuple(
            2 * frequencies * self.audio_channels
            for frequencies in freqs_per_bands
        )
        self.band_split = BandSplit(
            dimension,
            complex_input_dimensions,
        )
        self.mask_estimators = ModuleList(
            [
                MaskEstimator(
                    dimension,
                    complex_input_dimensions,
                    depth=mask_estimator_depth,
                    expansion_factor=mlp_expansion_factor,
                )
                for _ in range(num_stems)
            ]
        )
        self.zero_dc = zero_dc

    def forward(self, raw_audio: Tensor) -> Tensor:
        device = raw_audio.device
        if raw_audio.ndim == 2:
            raw_audio = rearrange(raw_audio, "b t -> b 1 t")
        channels = raw_audio.shape[1]
        if (self.stereo and channels != 2) or (
            not self.stereo and channels != 1
        ):
            raise ValueError(
                f"Unexpected channel count for BS-RoFormer: {channels}"
            )

        packed_audio, packed_audio_shape = _pack_one(raw_audio, "* t")
        stft_window = self.stft_window_fn(device=device)
        stft = torch.stft(
            packed_audio,
            **self.stft_kwargs,
            window=stft_window,
            return_complex=True,
        )
        stft = torch.view_as_real(stft)
        stft = _unpack_one(
            stft,
            packed_audio_shape,
            "* f t c",
        )
        stft = rearrange(stft, "b s f t c -> b (f s) t c")
        value = rearrange(stft, "b f t c -> b t (f c)")
        value = self.band_split(value)

        stored: list[Tensor | None] = [None] * len(self.layers)
        for index, transformer_block in enumerate(self.layers):
            time_transformer, frequency_transformer = transformer_block
            if self.skip_connection:
                for previous in stored[:index]:
                    if previous is not None:
                        value = value + previous
            value = rearrange(value, "b t f d -> b f t d")
            value, packed_shape = pack([value], "* t d")
            value = time_transformer(value)
            value = unpack(value, packed_shape, "* t d")[0]
            value = rearrange(value, "b f t d -> b t f d")
            value, packed_shape = pack([value], "* f d")
            value = frequency_transformer(value)
            value = unpack(value, packed_shape, "* f d")[0]
            if self.skip_connection:
                stored[index] = value

        value = self.final_norm(value)
        mask = torch.stack(
            [estimator(value) for estimator in self.mask_estimators],
            dim=1,
        )
        mask = rearrange(
            mask,
            "b n t (f c) -> b n f t c",
            c=2,
        )
        stft = rearrange(stft, "b f t c -> b 1 f t c")
        estimated_stft = torch.view_as_complex(stft) * torch.view_as_complex(
            mask
        )
        estimated_stft = rearrange(
            estimated_stft,
            "b n (f s) t -> (b n s) f t",
            s=self.audio_channels,
        )
        if self.zero_dc:
            estimated_stft[:, 0] = 0.0
        reconstructed = torch.istft(
            estimated_stft,
            **self.stft_kwargs,
            window=stft_window,
            return_complex=False,
            length=packed_audio.shape[-1],
        )
        return rearrange(
            reconstructed,
            "(b n s) t -> b n s t",
            s=self.audio_channels,
            n=self.num_stems,
        )
