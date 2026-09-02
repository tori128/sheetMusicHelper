import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface RunState {
  pid: number;
  version: string;
  startedAt: string;
  lastHeartbeat: string;
}

type Clock = () => Date;

export class RunStateTracker {
  #timer: ReturnType<typeof setInterval> | null = null;
  #startedAt = "";

  constructor(
    private readonly path: string,
    private readonly version: string,
    private readonly heartbeatIntervalMs = 5_000,
    private readonly clock: Clock = () => new Date(),
  ) {}

  start(): RunState | null {
    const previous = this.#readPrevious();
    this.#startedAt = this.clock().toISOString();
    this.#writeHeartbeat();
    this.#timer = setInterval(
      () => this.#writeHeartbeat(),
      this.heartbeatIntervalMs,
    );
    this.#timer.unref();
    return previous;
  }

  stopCleanly(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    try {
      unlinkSync(this.path);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  #readPrevious(): RunState | null {
    if (!existsSync(this.path)) {
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as RunState;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.version === "string" &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.lastHeartbeat === "string"
      ) {
        return parsed;
      }
    } catch {
      // Fall back to the file timestamp when a hard stop interrupted a write.
    }
    const modifiedAt = statSync(this.path).mtime.toISOString();
    return {
      pid: 0,
      version: "unknown",
      startedAt: modifiedAt,
      lastHeartbeat: modifiedAt,
    };
  }

  #writeHeartbeat(): void {
    try {
      const now = this.clock().toISOString();
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify(
          {
            pid: process.pid,
            version: this.version,
            startedAt: this.#startedAt,
            lastHeartbeat: now,
          } satisfies RunState,
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      // Diagnostics must never terminate the application.
    }
  }
}
