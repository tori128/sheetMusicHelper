import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type { AppLogSink, AppLogLevel } from "./app-logger.js";

export interface ServiceConnection {
  baseUrl: string;
  token: string;
}

export interface ServiceFailure {
  kind: "error" | "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
  message: string;
}

type ServiceFailureHandler = (failure: ServiceFailure) => void;

const currentDirectory = dirname(fileURLToPath(import.meta.url));

function resolvePortableRoot(): string {
  const projectRoot = join(currentDirectory, "..", "..");
  const launcherRoot = process.env.EARCOPY_LAUNCHER_ROOT;
  return app.isPackaged
    ? (launcherRoot ??
      process.env.PORTABLE_EXECUTABLE_DIR ??
      dirname(app.getPath("exe")))
    : projectRoot;
}

export function resolvePortableUserDataPath(): string {
  return join(resolvePortableRoot(), "UserData");
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("動的ポートを割り当てられませんでした"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForHealth(baseUrl: string, process: ChildProcessWithoutNullStreams) {
  const deadline = Date.now() + 30_000;
  let processError: Error | null = null;
  const onProcessError = (error: Error) => {
    processError = error;
  };
  process.once("error", onProcessError);
  try {
    while (Date.now() < deadline) {
      if (processError !== null) {
        throw processError;
      }
      if (process.exitCode !== null) {
        throw new Error(`ローカルサービスが終了しました: ${process.exitCode}`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/v1/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          return;
        }
      } catch {
        if (processError !== null) {
          throw processError;
        }
        // 起動完了まで接続エラーと応答待ちタイムアウトを再試行する。
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    process.off("error", onProcessError);
  }
  throw new Error("ローカルサービスの起動確認がタイムアウトしました");
}

export class ServiceManager {
  #process: ChildProcessWithoutNullStreams | null = null;
  #connection: ServiceConnection | null = null;
  #startPromise: Promise<ServiceConnection> | null = null;
  #generation = 0;

  constructor(
    private readonly logger: AppLogSink | null = null,
    private readonly onUnexpectedFailure: ServiceFailureHandler | null = null,
  ) {}

  async start(): Promise<ServiceConnection> {
    if (this.#connection !== null) {
      return this.#connection;
    }
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }
    const startPromise = this.#start(this.#generation);
    this.#startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.#startPromise === startPromise) {
        this.#startPromise = null;
      }
    }
  }

  async #start(generation: number): Promise<ServiceConnection> {
    const port = await findFreePort();
    if (generation !== this.#generation) {
      throw new Error("ローカルサービスの起動が中断されました");
    }
    const token = randomBytes(32).toString("hex");
    const baseUrl = `http://127.0.0.1:${port}`;
    const projectRoot = join(currentDirectory, "..", "..");
    const portableRoot = resolvePortableRoot();
    const portableUserData = resolvePortableUserDataPath();
    const modelDirectories = app.isPackaged
      ? [join(portableRoot, "models", "muscriptor")]
      : [join(projectRoot, "models", "muscriptor")];
    const env = {
      ...process.env,
      EARCOPY_SESSION_TOKEN: token,
      EARCOPY_USER_DATA: portableUserData,
      EARCOPY_MODELS_DIRS: modelDirectories.join(delimiter),
      EARCOPY_STEM_MODEL_DIR: join(portableRoot, "models"),
    };

    const executable = app.isPackaged
      ? join(process.resourcesPath, "backend", "earcopy_service.exe")
      : "uv";
    const args = app.isPackaged
      ? [
          "--port",
          String(port),
          "--parent-pid",
          String(process.pid),
        ]
      : [
          "run",
          "earcopy-service",
          "--port",
          String(port),
          "--parent-pid",
          String(process.pid),
        ];
    const workingDirectory = app.isPackaged
      ? process.resourcesPath
      : projectRoot;

    this.#log("INFO", `ローカルサービスを起動します: port=${port}`);
    const service = spawn(executable, args, {
      cwd: workingDirectory,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    service.stdin.end();
    service.stdout.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message) {
        this.#log("INFO", message, "service:stdout");
      }
    });
    service.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (!message) {
        return;
      }
      console.error(`[service] ${message}`);
      this.#log("INFO", message, "service:stderr");
    });
    this.#process = service;
    service.on("error", (error) => {
      console.error(`[service] ${error.message}`);
      this.#log("ERROR", error.stack ?? error.message);
      const wasConnected =
        this.#process === service && this.#connection !== null;
      if (this.#process === service) {
        this.#process = null;
        this.#connection = null;
        this.#terminate(service);
      }
      if (wasConnected) {
        this.onUnexpectedFailure?.({
          kind: "error",
          code: service.exitCode,
          signal: null,
          message: error.message,
        });
      }
    });
    service.once("exit", (code, signal) => {
      const wasConnected =
        this.#process === service && this.#connection !== null;
      this.#log(
        code === 0 ? "INFO" : "WARN",
        `ローカルサービスが終了しました: code=${code ?? "null"}, signal=${signal ?? "null"}`,
      );
      if (this.#process === service) {
        this.#process = null;
        this.#connection = null;
      }
      if (wasConnected) {
        this.onUnexpectedFailure?.({
          kind: "exit",
          code,
          signal,
          message: `code=${code ?? "null"}, signal=${signal ?? "null"}`,
        });
      }
    });
    try {
      await waitForHealth(baseUrl, service);
    } catch (error) {
      this.#log(
        "ERROR",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      if (this.#process === service) {
        this.#process = null;
        this.#connection = null;
        this.#terminate(service);
      }
      throw error;
    }
    if (
      generation !== this.#generation ||
      this.#process !== service ||
      service.exitCode !== null
    ) {
      throw new Error("ローカルサービスの起動が中断されました");
    }
    this.#connection = { baseUrl, token };
    this.#log("INFO", `ローカルサービスの起動を確認しました: port=${port}`);
    return this.#connection;
  }

  stop(): void {
    const service = this.#process;
    this.#generation += 1;
    this.#process = null;
    this.#connection = null;
    this.#startPromise = null;
    if (service !== null) {
      this.#log("INFO", "ローカルサービスを停止します");
      this.#terminate(service);
    }
  }

  #log(
    level: AppLogLevel,
    message: string,
    source = "service-manager",
  ): void {
    this.logger?.log(level, source, message);
  }

  #terminate(service: ChildProcessWithoutNullStreams): void {
    if (service.pid !== undefined && process.platform === "win32") {
      const terminator = spawn(
        "taskkill.exe",
        ["/pid", String(service.pid), "/T", "/F"],
        {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      terminator.once("error", (error) => {
        this.#log(
          "WARN",
          `ローカルサービスの強制停止に失敗しました: ${error.message}`,
        );
      });
      terminator.unref();
    } else if (service.pid !== undefined) {
      service.kill();
    }
  }
}
