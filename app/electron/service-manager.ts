import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

export interface ServiceConnection {
  baseUrl: string;
  token: string;
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));

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
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`ローカルサービスが終了しました: ${process.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // 起動完了まで短時間だけ再試行する。
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("ローカルサービスの起動確認がタイムアウトしました");
}

export class ServiceManager {
  #process: ChildProcessWithoutNullStreams | null = null;
  #connection: ServiceConnection | null = null;

  async start(): Promise<ServiceConnection> {
    if (this.#connection !== null) {
      return this.#connection;
    }
    const port = await findFreePort();
    const token = randomBytes(32).toString("hex");
    const baseUrl = `http://127.0.0.1:${port}`;
    const projectRoot = join(currentDirectory, "..", "..");
    const launcherRoot = process.env.EARCOPY_LAUNCHER_ROOT;
    const portableRoot = app.isPackaged
      ? (launcherRoot ??
        process.env.PORTABLE_EXECUTABLE_DIR ??
        dirname(app.getPath("exe")))
      : projectRoot;
    const portableUserData = join(portableRoot, "UserData");
    const modelDirectories = [
      join(portableRoot, "models", "muscriptor"),
      join(portableRoot, "..", "models", "muscriptor"),
    ];
    const env = {
      ...process.env,
      EARCOPY_SESSION_TOKEN: token,
      EARCOPY_USER_DATA: portableUserData,
      EARCOPY_MODELS_DIRS: modelDirectories.join(delimiter),
      EARCOPY_SCNET_MODEL_DIR: app.isPackaged
        ? join(process.resourcesPath, "models", "scnet", "large")
        : join(projectRoot, "models", "scnet", "large"),
    };

    const executable = app.isPackaged
      ? join(process.resourcesPath, "backend", "earcopy_service.exe")
      : "uv";
    const args = app.isPackaged
      ? ["--port", String(port)]
      : ["run", "earcopy-service", "--port", String(port)];
    const workingDirectory = app.isPackaged
      ? process.resourcesPath
      : projectRoot;

    const service = spawn(executable, args, {
      cwd: workingDirectory,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    service.stdin.end();
    service.stderr.on("data", (chunk: Buffer) => {
      console.error(`[service] ${chunk.toString().trimEnd()}`);
    });
    this.#process = service;
    try {
      await waitForHealth(baseUrl, service);
    } catch (error) {
      service.kill();
      this.#process = null;
      throw error;
    }
    this.#connection = { baseUrl, token };
    return this.#connection;
  }

  stop(): void {
    if (this.#process?.pid !== undefined && process.platform === "win32") {
      spawnSync(
        "taskkill.exe",
        ["/pid", String(this.#process.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
    } else {
      this.#process?.kill();
    }
    this.#process = null;
    this.#connection = null;
  }
}
