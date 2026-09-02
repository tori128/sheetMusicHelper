// @vitest-environment node

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStateTracker } from "../electron/run-state";

describe("RunStateTracker", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records heartbeats and removes the marker after a clean stop", () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "earcopy-run-state-"));
    directories.push(directory);
    const path = join(directory, "run-state.json");
    let now = new Date("2026-07-28T01:00:00.000Z");
    const tracker = new RunStateTracker(path, "0.1.0", 5_000, () => now);

    expect(tracker.start()).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: "0.1.0",
      startedAt: "2026-07-28T01:00:00.000Z",
      lastHeartbeat: "2026-07-28T01:00:00.000Z",
    });

    now = new Date("2026-07-28T01:00:05.000Z");
    vi.advanceTimersByTime(5_000);
    expect(JSON.parse(readFileSync(path, "utf8")).lastHeartbeat).toBe(
      "2026-07-28T01:00:05.000Z",
    );

    tracker.stopCleanly();
    expect(() => readFileSync(path)).toThrow();
  });

  it("returns the previous marker as an unclean run", () => {
    const directory = mkdtempSync(join(tmpdir(), "earcopy-run-state-"));
    directories.push(directory);
    const path = join(directory, "run-state.json");
    writeFileSync(
      path,
      JSON.stringify({
        pid: 1234,
        version: "0.1.0",
        startedAt: "2026-07-28T00:48:57.000Z",
        lastHeartbeat: "2026-07-28T00:50:58.000Z",
      }),
      "utf8",
    );
    const tracker = new RunStateTracker(
      path,
      "0.1.1",
      5_000,
      () => new Date("2026-07-28T01:00:00.000Z"),
    );

    expect(tracker.start()).toEqual({
      pid: 1234,
      version: "0.1.0",
      startedAt: "2026-07-28T00:48:57.000Z",
      lastHeartbeat: "2026-07-28T00:50:58.000Z",
    });
    tracker.stopCleanly();
  });
});
