import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, LocalApiClient } from "./api";

const client = new LocalApiClient({ baseUrl: "http://127.0.0.1:54321", token: "secret" });
function response(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
afterEach(() => vi.unstubAllGlobals());

describe("model download progress", () => {
  it("receives byte progress and returns the registered model across split SSE frames", async () => {
    const profile = { id: "registered-medium", variant: "medium" };
    const first = { phase: "downloading", completedBytes: 0, totalBytes: 100 };
    const second = { ...first, completedBytes: 50 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([
      { type: "progress", progress: first }, { type: "progress", progress: second },
      { type: "complete", result: profile },
    ])));
    const progress = vi.fn();
    await expect(client.downloadModel("medium", progress)).resolves.toEqual(profile);
    expect(progress.mock.calls.map(call => call[0])).toEqual([first, second]);
  });
  it("propagates a download failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([{ type: "error", message: "受信に失敗しました", status: 400 }])));
    await expect(client.downloadModel("small", vi.fn())).rejects.toThrow("受信に失敗しました");
  });
  it("rejects a stream that ends before a completion event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([])));
    await expect(client.downloadModel("large", vi.fn())).rejects.toBeInstanceOf(ApiError);
  });
});
