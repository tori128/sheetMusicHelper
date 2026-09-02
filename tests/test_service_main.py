import os
import socket
import subprocess
import sys
import time

import pytest

from earcopy_service.__main__ import (
    _exit_when_parent_stops,
    _process_is_running,
)


def test_process_is_running_detects_current_process() -> None:
    assert _process_is_running(os.getpid())
    assert not _process_is_running(-1)


def test_parent_watchdog_exits_after_parent_stops() -> None:
    running_states = iter([True, True, False])
    sleep_intervals: list[float] = []
    exit_codes: list[int] = []

    _exit_when_parent_stops(
        123,
        lambda _process_id: next(running_states),
        sleep_intervals.append,
        exit_codes.append,
    )

    assert sleep_intervals == [0.25, 0.25]
    assert exit_codes == [0]


def test_service_exits_when_watched_parent_process_stops() -> None:
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]

    watched_parent = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "earcopy_service",
            "--port",
            str(port),
            "--parent-pid",
            str(watched_parent.pid),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail(
                    f"service exited during startup: {process.returncode}"
                )
            with socket.socket() as client:
                client.settimeout(0.1)
                if client.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        else:
            pytest.fail("service did not start")

        watched_parent.terminate()
        watched_parent.wait(timeout=5)

        assert process.wait(timeout=5) == 0
    finally:
        if watched_parent.poll() is None:
            watched_parent.kill()
            watched_parent.wait(timeout=5)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
