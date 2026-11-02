import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from earcopy_service.download_progress import DownloadProgress, stream_download


def test_progress_stream_ends_with_the_operation_result():
    app = FastAPI()

    @app.post("/download")
    def download():
        def operation(report):
            report(DownloadProgress("downloading", 0, 12))
            report(DownloadProgress("downloading", 12, 12))
            report(DownloadProgress("verifying", 0, 0))
            return {"available": True}
        return stream_download(operation)

    response = TestClient(app).post("/download")
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert response.headers["content-type"].startswith("text/event-stream")
    assert events[0]["progress"]["completedBytes"] == 0
    assert events[1]["progress"]["completedBytes"] == 12
    assert events[-1] == {"type": "complete", "result": {"available": True}}


def test_failed_download_sends_an_error_instead_of_completion():
    app = FastAPI()

    @app.post("/download")
    def download():
        def operation(report):
            report(DownloadProgress("downloading", 0, 12))
            raise OSError("接続に失敗しました")
        return stream_download(operation)

    response = TestClient(app).post("/download")
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == {"type": "error", "message": "接続に失敗しました", "status": 400}
    assert all(event["type"] != "complete" for event in events)
