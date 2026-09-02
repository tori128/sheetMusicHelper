const { rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const MAX_SHUTDOWN_MS = 3_000;
const TEST_TIMEOUT_MS = 20_000;
const electron = require("electron");
const userDataPath = join(
  tmpdir(),
  `earcopy-shutdown-smoke-${process.pid}-${Date.now()}`,
);

function terminateProcessTree(processId) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(processId), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 3_000,
    });
    return;
  }
  process.kill(processId, "SIGKILL");
}

function cleanup() {
  try {
    rmSync(userDataPath, { recursive: true, force: true });
  } catch {
    // Windows may release Chromium cache files shortly after process exit.
  }
}

const child = spawn(
  electron,
  [resolve("."), "--disable-gpu", "--disable-software-rasterizer"],
  {
    cwd: resolve("."),
    env: {
      ...process.env,
      EARCOPY_SHUTDOWN_SMOKE_TEST: "1",
      EARCOPY_SMOKE_USER_DATA_PATH: userDataPath,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
let shutdownStartedAt = null;
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    if (
      shutdownStartedAt === null &&
      text.includes("electron-shutdown-smoke-ready")
    ) {
      shutdownStartedAt = Date.now();
    }
    process.stdout.write(chunk);
  });
}

const timer = setTimeout(() => {
  if (child.pid !== undefined) {
    terminateProcessTree(child.pid);
  }
  cleanup();
  console.error(`Electron shutdown smoke timed out.\n${output}`);
  process.exit(2);
}, TEST_TIMEOUT_MS);

child.on("error", (error) => {
  clearTimeout(timer);
  cleanup();
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  clearTimeout(timer);
  cleanup();
  const elapsedMs =
    shutdownStartedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - shutdownStartedAt;
  if (
    code !== 0 ||
    !output.includes("renderer-hang-smoke-armed") ||
    elapsedMs > MAX_SHUTDOWN_MS
  ) {
    console.error(
      `Electron shutdown smoke failed (exit=${code}, shutdownMs=${elapsedMs}).\n${output}`,
    );
    process.exit(code || 2);
  }
  console.log(`electron-renderer-hang-shutdown-smoke: ${elapsedMs} ms`);
});
