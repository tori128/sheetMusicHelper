from __future__ import annotations

import atexit
import faulthandler
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import TextIO

_MAX_BACKEND_LOG_BYTES = 5 * 1024 * 1024
_lock = threading.Lock()
_enabled = False
_fault_stream: TextIO | None = None


def _log_directory() -> Path:
    return Path(os.getenv("EARCOPY_USER_DATA", "UserData")) / "logs"


def diagnostics_enabled() -> bool:
    return _enabled


def log_backend_event(source: str, message: str) -> None:
    if not _enabled:
        return
    timestamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
    sanitized = message.replace("\r", "\\r").replace("\n", "\\n")
    line = f"[{timestamp}] [{source}] {sanitized}\n"
    try:
        with _lock:
            directory = _log_directory()
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / "backend.log"
            if path.is_file() and path.stat().st_size >= _MAX_BACKEND_LOG_BYTES:
                archive = directory / "backend-previous.log"
                archive.unlink(missing_ok=True)
                path.replace(archive)
            with path.open("a", encoding="utf-8") as target:
                target.write(line)
                target.flush()
    except OSError:
        pass


def enable_crash_diagnostics() -> Path:
    global _enabled, _fault_stream

    if _enabled and _fault_stream is not None:
        return Path(_fault_stream.name)

    directory = _log_directory()
    directory.mkdir(parents=True, exist_ok=True)
    crash_path = directory / "backend-crash.log"
    _fault_stream = crash_path.open("a", encoding="utf-8", buffering=1)
    _fault_stream.write(
        "\n"
        f"=== backend session {datetime.now().astimezone().isoformat()} "
        f"pid={os.getpid()} ===\n"
    )
    _fault_stream.flush()
    faulthandler.enable(file=_fault_stream, all_threads=True)
    _enabled = True
    atexit.register(disable_crash_diagnostics)
    log_backend_event("process", f"started pid={os.getpid()}")
    return crash_path


def disable_crash_diagnostics() -> None:
    global _enabled, _fault_stream

    if not _enabled:
        return
    log_backend_event("process", f"stopped pid={os.getpid()}")
    _enabled = False
    if _fault_stream is not None:
        try:
            faulthandler.disable()
            _fault_stream.close()
        except OSError:
            pass
        _fault_stream = None
