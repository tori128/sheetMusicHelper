// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function runExitHandler(script: string, applicationExitMs: number): number | null {
  const source = readFileSync(resolve("scripts", script), "utf8");
  const marker = 'child.on("exit", (code) => {';
  const start = source.lastIndexOf(marker);
  if (start < 0) throw new Error("The process exit handler was not found.");
  let handler: ((code: number) => void) | undefined;
  let now = 1_000 + applicationExitMs;
  let exitCode: number | null = null;
  const stopped = new Error("Test process exit");
  runInNewContext(source.slice(start), {
    child: { on: (_event: string, callback: (code: number) => void) => { handler = callback; } },
    Date: { now: () => now },
    shutdownStartedAt: 1_000,
    timer: 0,
    clearTimeout: () => {},
    existsSync: () => false,
    resultPath: "result.txt",
    result: "ok",
    output: 'renderer-hang-smoke-armed\nelectron-smoke-ready\nmusicxml-preview-smoke: {"svgCount":1}\n',
    cleanup: () => { now += 8_000; },
    existingBackendProcessIds: new Set<number>(),
    waitForNewBackendProcessesToExit: () => [],
    terminateProcessTree: () => {},
    MAX_RENDERER_HANG_SHUTDOWN_MS: 3_000,
    MAX_SHUTDOWN_MS: 3_000,
    sampleRate: 8_000,
    console: { log: vi.fn(), error: vi.fn() },
    process: { exit: (code: number) => { exitCode = code; throw stopped; } },
  });
  if (handler === undefined) throw new Error("The process exit handler was not registered.");
  try {
    handler(0);
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return exitCode;
}

describe.each(["smoke-packaged.cjs", "smoke-shutdown.cjs"])("%s shutdown timing", (script) => {
  it("accepts a 1.5-second exit when temporary-file cleanup takes 8 seconds", () => {
    expect(runExitHandler(script, 1_500)).toBeNull();
  });

  it("rejects an application exit exceeding the 3-second limit", () => {
    expect(runExitHandler(script, 3_500)).toBe(2);
  });
});
