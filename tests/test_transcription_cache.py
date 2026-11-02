import os
from pathlib import Path

from earcopy_service.backends import (
    BackendInvalidChunk,
    BackendNoteEnd,
    BackendNoteStart,
    BackendProgress,
)
from earcopy_service.transcription_cache import TranscriptionResultCache


def _cache_key(
    cache: TranscriptionResultCache,
    audio: Path,
    model: Path,
    instruments: list[str] | None = None,
    *,
    prelude_forcing: bool = True,
    batch_size: int = 1,
) -> str:
    key = cache.key(
        audio_path=audio,
        model_path=model,
        backend="CUDA",
        dtype="float16",
        instruments=instruments,
        prelude_forcing=prelude_forcing,
        batch_size=batch_size,
    )
    assert key is not None
    return key


def test_round_trips_backend_events_before_note_routing(tmp_path: Path) -> None:
    audio = tmp_path / "input.wav"
    model = tmp_path / "model.safetensors"
    audio.write_bytes(b"same audio")
    model.write_bytes(b"model")
    cache = TranscriptionResultCache(tmp_path / "cache")
    key = _cache_key(cache, audio, model, ["string_ensemble"])
    events = [
        BackendNoteStart(7, "string_ensemble", 64, 1.25),
        BackendNoteEnd(7, 1.75),
        BackendInvalidChunk(2, 10.0, 15.0, "token limit"),
    ]

    cache.save(key, events, 12)
    cached = cache.load(key)

    assert cached is not None
    assert cached.events == tuple(events)
    assert cached.progress_total == 12


def test_key_uses_audio_content_and_transcription_conditions(
    tmp_path: Path,
) -> None:
    first_audio = tmp_path / "first.wav"
    second_audio = tmp_path / "second.wav"
    model = tmp_path / "model.safetensors"
    first_audio.write_bytes(b"identical")
    second_audio.write_bytes(b"identical")
    model.write_bytes(b"model")
    cache = TranscriptionResultCache(tmp_path / "cache")

    first = _cache_key(cache, first_audio, model, ["string_ensemble"])
    second = _cache_key(cache, second_audio, model, ["string_ensemble"])
    automatic = _cache_key(cache, second_audio, model, None)

    assert first == second
    assert automatic != first


def test_key_distinguishes_transcription_profiles(tmp_path: Path) -> None:
    audio = tmp_path / "input.wav"
    model = tmp_path / "model.safetensors"
    audio.write_bytes(b"audio")
    model.write_bytes(b"model")
    cache = TranscriptionResultCache(tmp_path / "cache")

    high_accuracy = _cache_key(cache, audio, model, ["string_ensemble"])
    fast = _cache_key(
        cache,
        audio,
        model,
        ["string_ensemble"],
        prelude_forcing=False,
        batch_size=3,
    )

    assert fast != high_accuracy


def test_replays_cache_without_loading_or_calling_backend(tmp_path: Path) -> None:
    audio = tmp_path / "input.wav"
    model = tmp_path / "model.safetensors"
    audio.write_bytes(b"audio")
    model.write_bytes(b"model")
    cache = TranscriptionResultCache(tmp_path / "cache")
    key = _cache_key(cache, audio, model, ["string_ensemble"])
    cache.save(
        key,
        [
            BackendNoteStart(3, "string_ensemble", 60, 0.5),
            BackendNoteEnd(3, 1.0),
        ],
        4,
    )
    replayed = []

    class Backend:
        def transcribe(self, *_args, **_kwargs):
            raise AssertionError("backend must not run on a cache hit")

    hit = cache.transcribe(
        key=key,
        backend=Backend(),
        audio_path=audio,
        instruments=["string_ensemble"],
        prelude_forcing=True,
        batch_size=1,
        on_event=replayed.append,
        cancel_check=lambda: False,
        ensure_backend_loaded=lambda: (_ for _ in ()).throw(
            AssertionError("model must not load on a cache hit")
        ),
    )

    assert hit is True
    assert replayed[-1] == BackendProgress(completed=4, total=4)
    assert replayed[:-1] == [
        BackendNoteStart(3, "string_ensemble", 60, 0.5),
        BackendNoteEnd(3, 1.0),
    ]


def test_does_not_save_cancelled_transcription(tmp_path: Path) -> None:
    audio = tmp_path / "input.wav"
    model = tmp_path / "model.safetensors"
    audio.write_bytes(b"audio")
    model.write_bytes(b"model")
    cache = TranscriptionResultCache(tmp_path / "cache")
    key = _cache_key(cache, audio, model, ["string_ensemble"])
    cancelled = False

    class Backend:
        def transcribe(
            self,
            _audio_path,
            _instruments,
            on_event,
            *,
            beam_size=1,
            prelude_forcing=True,
            batch_size=1,
        ):
            nonlocal cancelled
            on_event(BackendProgress(completed=0, total=4))
            on_event(BackendNoteStart(3, "string_ensemble", 60, 0.5))
            cancelled = True

    hit = cache.transcribe(
        key=key,
        backend=Backend(),
        audio_path=audio,
        instruments=["string_ensemble"],
        prelude_forcing=True,
        batch_size=1,
        on_event=lambda _event: None,
        cancel_check=lambda: cancelled,
        ensure_backend_loaded=lambda: None,
    )

    assert hit is False
    assert cache.load(key) is None


def test_keeps_ten_most_recent_transcription_results(tmp_path: Path) -> None:
    root = tmp_path / "transcriptions"
    cache = TranscriptionResultCache(root)

    for index in range(12):
        key = f"{index:064x}"
        cache.save(key, [], 1)
        path = root / f"{key}.json.gz"
        os.utime(path, (1_000_000 + index, 1_000_000 + index))

    retained = {path.name for path in root.glob("*.json.gz")}
    assert retained == {
        f"{index:064x}.json.gz" for index in range(2, 12)
    }


def test_loading_transcription_updates_its_last_used_time(tmp_path: Path) -> None:
    root = tmp_path / "transcriptions"
    cache = TranscriptionResultCache(root)
    key = "a" * 64
    cache.save(key, [], 1)
    path = root / f"{key}.json.gz"
    os.utime(path, (1_000_000, 1_000_000))

    assert cache.load(key) is not None

    assert path.stat().st_mtime > 1_000_000
