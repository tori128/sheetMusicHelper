# Vendored BS-RoFormer inference core

Source: <https://github.com/ZFTurbo/Music-Source-Separation-Training>

The inference architecture was adapted from
`models/bs_roformer/bs_roformer.py` and
`models/bs_roformer/attend.py` on 2026-07-31. Training-only loss code,
PoPE, linear attention, and checkpointing paths were removed. Module names
and parameter layout remain compatible with the BS-RoFormer SW Fixed
checkpoint.

Upstream file blob SHA-1 values:

- `bs_roformer.py`: `60fa27942e09fbdf4f9463259fd0b80582d9e39c`
- `attend.py`: `d6dc4b3079cff5b3c8c90cea8df2301afd18918b`

The upstream MIT license is included in
`app/resources/licenses/MSST/LICENSE.md`. Model weights are not vendored or
redistributed.
