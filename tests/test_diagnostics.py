from __future__ import annotations

from pathlib import Path

from earcopy_service.diagnostics import (
    disable_crash_diagnostics,
    enable_crash_diagnostics,
    log_backend_event,
)


def test_backend_diagnostics_write_direct_logs(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("EARCOPY_USER_DATA", str(tmp_path))
    try:
        crash_path = enable_crash_diagnostics()
        log_backend_event("test", "stage=separating\nnext=chunk")
    finally:
        disable_crash_diagnostics()

    backend_log = (tmp_path / "logs" / "backend.log").read_text(
        encoding="utf-8"
    )
    assert "[test] stage=separating\\nnext=chunk" in backend_log
    assert "[process] started pid=" in backend_log
    assert "[process] stopped pid=" in backend_log
    assert crash_path == tmp_path / "logs" / "backend-crash.log"
    assert "backend session" in crash_path.read_text(encoding="utf-8")
