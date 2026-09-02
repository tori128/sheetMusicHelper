from __future__ import annotations

import argparse
import os
import time
from threading import Thread
from typing import Callable

import uvicorn

from .diagnostics import (
    disable_crash_diagnostics,
    enable_crash_diagnostics,
    log_backend_event,
)


def _process_is_running(process_id: int) -> bool:
    if process_id <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
        ]
        open_process.restype = wintypes.HANDLE
        wait_for_single_object = kernel32.WaitForSingleObject
        wait_for_single_object.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        wait_for_single_object.restype = wintypes.DWORD
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = [wintypes.HANDLE]
        close_handle.restype = wintypes.BOOL

        synchronize = 0x00100000
        wait_timeout = 0x00000102
        handle = open_process(synchronize, False, process_id)
        if not handle:
            return False
        try:
            return wait_for_single_object(handle, 0) == wait_timeout
        finally:
            close_handle(handle)

    try:
        os.kill(process_id, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def _exit_when_parent_stops(
    parent_process_id: int,
    is_running: Callable[[int], bool] = _process_is_running,
    sleep: Callable[[float], object] = time.sleep,
    exit_process: Callable[[int], object] = os._exit,
) -> None:
    while is_running(parent_process_id):
        sleep(0.25)
    exit_process(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="EarCopy Assist local service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        parser.error("ローカルサービスはloopbackアドレスでのみ起動できます")
    crash_log = enable_crash_diagnostics()
    log_backend_event(
        "process",
        f"listening host={args.host} port={args.port} crash_log={crash_log}",
    )
    if args.parent_pid is not None:
        if args.parent_pid <= 0:
            parser.error("--parent-pidは正数で指定してください")
        Thread(
            target=_exit_when_parent_stops,
            args=(args.parent_pid,),
            daemon=True,
            name="parent-process-watchdog",
        ).start()
    try:
        uvicorn.run("earcopy_service.api:app", host=args.host, port=args.port)
    finally:
        disable_crash_diagnostics()


if __name__ == "__main__":
    main()
