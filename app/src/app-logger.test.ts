// @vitest-environment node

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppLogger } from "../electron/app-logger";

describe("AppLogger", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes app.log and rotates it when the local date changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "earcopy-log-"));
    directories.push(directory);
    let now = new Date(2026, 6, 27, 22, 15, 30, 125);
    const logger = new AppLogger(() => directory, () => now);

    logger.log("INFO", "main", "started");
    now = new Date(2026, 6, 28, 0, 0, 1, 250);
    logger.log("ERROR", "service", "line one\nline two");

    expect(readdirSync(directory).sort()).toEqual([
      "app-2026-07-27.log",
      "app.log",
    ]);
    expect(
      readFileSync(join(directory, "app-2026-07-27.log"), "utf8"),
    ).toContain("[INFO] [main] started");
    const active = readFileSync(join(directory, "app.log"), "utf8");
    expect(active).toContain("[ERROR] [service] line one");
    expect(active).toContain("[ERROR] [service] line two");
    expect(active).not.toContain("started");
  });
});
