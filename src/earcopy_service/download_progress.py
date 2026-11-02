from __future__ import annotations

import asyncio
import json
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool


DownloadPhase = Literal["preparing", "downloading", "verifying", "assembling", "extracting", "registering"]


@dataclass(frozen=True)
class DownloadProgress:
    phase: DownloadPhase
    completed_bytes: int
    total_bytes: int


ProgressCallback = Callable[[DownloadProgress], None]


def report_progress(callback: ProgressCallback | None, phase: DownloadPhase, completed: int = 0, total: int = 0) -> None:
    if callback is not None:
        callback(DownloadProgress(phase, completed, total))


def stream_download(operation: Callable[[ProgressCallback], Any]) -> StreamingResponse:
    async def events():
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        last_phase = None
        last_report = 0.0

        def report(progress: DownloadProgress) -> None:
            nonlocal last_phase, last_report
            now = time.monotonic()
            if progress.phase == last_phase and now - last_report < 0.1 and progress.completed_bytes != progress.total_bytes:
                return
            last_phase, last_report = progress.phase, now
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "progress", "progress": {
                    "phase": progress.phase, "completedBytes": progress.completed_bytes,
                    "totalBytes": progress.total_bytes,
                },
            })

        async def run():
            try:
                result = await run_in_threadpool(operation, report)
                if isinstance(result, BaseModel):
                    result = result.model_dump(by_alias=True, mode="json")
                await queue.put({"type": "complete", "result": result})
            except (OSError, RuntimeError, ValueError) as error:
                await queue.put({"type": "error", "message": str(error), "status": 400})
            except Exception:
                traceback.print_exc()
                await queue.put({"type": "error", "message": "モデル取得中にエラーが発生しました。ログを確認してください。", "status": 500})

        task = asyncio.create_task(run())
        try:
            while True:
                event = await queue.get()
                yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                if event["type"] in {"complete", "error"}:
                    break
        finally:
            await task

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
