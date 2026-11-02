import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export type AppLogLevel = "INFO" | "WARN" | "ERROR";

export interface AppLogSink {
  log(level: AppLogLevel, source: string, message: string): void;
}

type LogDirectoryProvider = () => string;
type Clock = () => Date;

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestamp(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${localDateKey(date)}T${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function existingLogDate(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const descriptor = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(11);
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    const match = /^\[(\d{4}-\d{2}-\d{2})/.exec(
      prefix.toString("utf8", 0, bytesRead),
    );
    return match?.[1] ?? localDateKey(statSync(path).mtime);
  } finally {
    closeSync(descriptor);
  }
}

function availableArchivePath(directory: string, dateKey: string): string {
  const basePath = join(directory, `app-${dateKey}.log`);
  if (!existsSync(basePath)) {
    return basePath;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = join(directory, `app-${dateKey}-${suffix}.log`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
}

export class AppLogger implements AppLogSink {
  constructor(
    private readonly directoryProvider: LogDirectoryProvider,
    private readonly clock: Clock = () => new Date(),
  ) {}

  log(level: AppLogLevel, source: string, message: string): void {
    try {
      const now = this.clock();
      const dateKey = localDateKey(now);
      const directory = this.directoryProvider();
      const activePath = join(directory, "app.log");
      mkdirSync(directory, { recursive: true });
      const previousDate = existingLogDate(activePath);
      if (previousDate !== null && previousDate !== dateKey) {
        renameSync(
          activePath,
          availableArchivePath(directory, previousDate),
        );
      }
      const lines = message.replace(/\r\n/g, "\n").split("\n");
      const entry = lines
        .map((line) => `[${timestamp(now)}] [${level}] [${source}] ${line}\n`)
        .join("");
      appendFileSync(activePath, entry, "utf8");
    } catch (error) {
      console.error(
        `[logger] ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
