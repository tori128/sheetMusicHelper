import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from "electron";
import { AppLogger } from "./app-logger.js";
import { RunStateTracker } from "./run-state.js";
import {
  resolvePortableUserDataPath,
  ServiceManager,
  type ServiceFailure,
} from "./service-manager.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const portableUserDataPath = resolvePortableUserDataPath();
const logPath = join(portableUserDataPath, "logs", "app.log");
const crashDirectory = join(portableUserDataPath, "crashes");
const spectralAnalysisDirectory = join(
  portableUserDataPath,
  "cache",
  "spectral-analysis",
);
mkdirSync(crashDirectory, { recursive: true });
app.setPath("crashDumps", crashDirectory);
crashReporter.start({
  companyName: "EarCopy Assist",
  productName: "EarCopy Assist",
  uploadToServer: false,
  compress: false,
});
const appLogger = new AppLogger(() =>
  join(portableUserDataPath, "logs"),
);
const runStateTracker = new RunStateTracker(
  join(portableUserDataPath, "logs", "run-state.json"),
  app.getVersion(),
);
let mainWindow: BrowserWindow | null = null;
let runtimeFailureDialogOpen = false;

async function showRuntimeFailure(
  title: string,
  message: string,
  detail: string,
): Promise<void> {
  if (
    runtimeFailureDialogOpen ||
    mainWindow === null ||
    mainWindow.isDestroyed()
  ) {
    return;
  }
  runtimeFailureDialogOpen = true;
  try {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title,
      message,
      detail: `${detail}\n\nログ: ${logPath}`,
      buttons: ["閉じる"],
      defaultId: 0,
    });
  } finally {
    runtimeFailureDialogOpen = false;
  }
}

function handleServiceFailure(failure: ServiceFailure): void {
  const occurredAt = new Date().toLocaleString();
  appLogger.log(
    "ERROR",
    "service-manager",
    `解析サービスの異常終了: ${failure.kind} ${failure.message}`,
  );
  void showRuntimeFailure(
    "解析処理が停止しました",
    "解析サービスが異常終了しました。",
    `発生時刻: ${occurredAt}\n${failure.message}`,
  );
}

const serviceManager = new ServiceManager(appLogger, handleServiceFailure);
const stopService = () => serviceManager.stop();
const SHUTDOWN_TIMEOUT_MS = 5_000;
let shutdownDeadline: ReturnType<typeof setTimeout> | null = null;

function startShutdown(): void {
  if (shutdownDeadline !== null) {
    return;
  }
  shutdownDeadline = setTimeout(() => {
    appLogger.log(
      "WARN",
      "main",
      `${SHUTDOWN_TIMEOUT_MS}ms以内に終了しなかったため強制終了します`,
    );
    stopService();
    app.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  shutdownDeadline.unref();
  appLogger.log("INFO", "main", "アプリケーションを終了します");
  runStateTracker.stopCleanly();
  stopService();
  // app.quit()/BrowserWindow.destroy() can wait for an unresponsive renderer.
  // Cleanup above is synchronous; exit without renderer cooperation afterward.
  app.exit(0);
}

process.on("uncaughtExceptionMonitor", (error) => {
  appLogger.log("ERROR", "main", `uncaughtException: ${error.stack ?? error.message}`);
});
process.on("unhandledRejection", (reason) => {
  appLogger.log("ERROR", "main", `unhandledRejection: ${String(reason)}`);
});
process.on("exit", () => {
  appLogger.log("INFO", "main", "Electron main processを終了します");
  stopService();
});

if (process.env.EARCOPY_SMOKE_TEST === "1") {
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-audio-output");
  const smokeUserDataPath = process.env.EARCOPY_SMOKE_USER_DATA_PATH;
  if (smokeUserDataPath) {
    app.setPath("userData", smokeUserDataPath);
    app.setPath("sessionData", join(smokeUserDataPath, "session"));
  }
}

if (process.env.EARCOPY_SHUTDOWN_SMOKE_TEST === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-audio-output");
  const smokeUserDataPath = process.env.EARCOPY_SMOKE_USER_DATA_PATH;
  if (smokeUserDataPath) {
    app.setPath("userData", smokeUserDataPath);
    app.setPath("sessionData", join(smokeUserDataPath, "session"));
  }
}

function describeSmokeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (error !== null && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    const fields = ["name", "message", "code", "stack"]
      .filter((key) => candidate[key] !== undefined)
      .map((key) => `${key}=${String(candidate[key])}`);
    if (fields.length > 0) {
      return fields.join("\n");
    }
    const serialized = JSON.stringify(error);
    if (serialized !== "{}") {
      return serialized;
    }
  }
  return String(error);
}

async function readLicenseNotices(): Promise<
  Array<{ name: string; text: string }>
> {
  const licenseRoot = app.isPackaged
    ? join(process.resourcesPath, "licenses")
    : join(currentDirectory, "..", "resources", "licenses");
  const files: Array<{ name: string; path: string }> = [];

  async function collect(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await collect(path, name);
      } else {
        files.push({ name, path });
      }
    }
  }

  await collect(licenseRoot);
  const backendRoot = app.isPackaged
    ? join(process.resourcesPath, "backend", "_internal")
    : join(
        currentDirectory,
        "..",
        "backend-dist",
        "earcopy_service",
        "_internal",
      );
  await collect(join(backendRoot, "licenses"), "Backend");
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      text: await readFile(file.path, "utf8"),
    })),
  );
}

async function verifySmokeWindow(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastState = "";
  while (Date.now() < deadline) {
    const result = (await window.webContents.executeJavaScript(`({
      apiReady: Boolean(
        window.desktopApi &&
        typeof window.desktopApi.getServiceConnection === "function"
      ),
      termsReady: Boolean(document.querySelector(".startup-terms-dialog")),
      termsText: document.querySelector(".startup-terms-dialog")?.textContent ?? "",
      screenReady: Boolean(document.querySelector(".new-project-screen")),
      backendReady: Boolean(
        document.querySelector('option[value="Auto"]:not(:disabled)') &&
        document.querySelector('option[value="CPU"]:not(:disabled)') &&
        document.querySelector('option[value="CUDA"]') &&
        document.querySelectorAll(
          'option[value="Auto"], option[value="CPU"], option[value="CUDA"]',
        ).length === 3
      ),
      modelLabels: [
        ...(
          [...document.querySelectorAll(".form-field")].find(
            (field) => field.textContent?.includes("MuScriptorモデル")
          )?.querySelectorAll("select option") ?? []
        )
      ].map((option) => option.textContent?.trim() ?? ""),
      errorText: document.querySelector(".bootstrap-message.is-error")?.textContent ?? "",
      bodyText: document.body?.innerText ?? "",
      readyState: document.readyState
    })`)) as {
      apiReady: boolean;
      termsReady: boolean;
      termsText: string;
      screenReady: boolean;
      backendReady: boolean;
      modelLabels: string[];
      errorText: string;
      bodyText: string;
      readyState: string;
    };
    lastState = JSON.stringify({
      bodyText: result.bodyText,
      readyState: result.readyState,
    });
    if (!result.apiReady) {
      throw new Error("preloadがdesktopApiを公開していません");
    }
    if (result.errorText) {
      throw new Error(`Renderer初期化エラー: ${result.errorText}`);
    }
    if (result.termsReady) {
      for (const requiredText of [
        "MuScriptorモデルの利用条件",
        "CC BY-NC 4.0",
        "非商用目的",
        "必要な権利または許諾",
      ]) {
        if (!result.termsText.includes(requiredText)) {
          throw new Error(`起動時の利用条件に必要な表示がありません: ${requiredText}`);
        }
      }
      await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector(".startup-terms-dialog");
        const checkbox = dialog?.querySelector('input[type="checkbox"]');
        const accept = [...(dialog?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent?.trim() === "同意して起動"
        );
        if (!checkbox || !accept) return false;
        if (!checkbox.checked) {
          checkbox.click();
          return true;
        }
        if (accept.disabled) return false;
        accept.click();
        return true;
      })()`);
      console.log("electron-smoke-stage: startup-terms");
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (result.screenReady) {
      console.log("electron-smoke-stage: renderer-ready");
      if (!result.backendReady) {
        throw new Error("推論バックエンド選択肢が仕様と一致しません");
      }
      if (
        process.env.EARCOPY_SMOKE_REQUIRE_MODELS === "1" &&
        ![
          "MuScriptor Small",
          "MuScriptor Medium",
          "MuScriptor Large",
        ].every((name) =>
          result.modelLabels.some((label) => label.includes(name)),
        )
      ) {
        throw new Error(
          `MuScriptorモデルが表示されません: ${result.modelLabels.join(", ")}`,
        );
      }
      console.log("electron-smoke-stage: settings");
      const settingsReady = (await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const button = document.querySelector('button[aria-label="設定"]');
          if (!button) {
            resolve(false);
            return;
          }
          button.click();
          const deadline = Date.now() + 5000;
          const timer = setInterval(() => {
            const dialog = document.querySelector(".settings-dialog");
            if (dialog) {
              const cacheTab = [...dialog.querySelectorAll('[role="tab"]')].find(
                (candidate) => candidate.textContent?.trim() === "キャッシュ"
              );
              if (cacheTab?.getAttribute("aria-selected") !== "true") {
                cacheTab?.click();
                return;
              }
              const cachePanel = dialog.querySelector(
                '[aria-label="キャッシュ設定"]'
              );
              const close = dialog.querySelector('button[aria-label="閉じる"]');
              if (cachePanel && close && !close.disabled) {
                clearInterval(timer);
                close.click();
                resolve(true);
              }
            } else if (Date.now() >= deadline) {
              clearInterval(timer);
              resolve(false);
            }
          }, 50);
        })
      `)) as boolean;
      if (!settingsReady) {
        throw new Error("キャッシュ設定画面を読み込めません");
      }
      const tempoAudioPath = process.env.EARCOPY_SMOKE_TEMPO_AUDIO_PATH;
      if (tempoAudioPath) {
        console.log("electron-smoke-stage: tempo");
        const connection = await serviceManager.start();
        const response = await fetch(
          `${connection.baseUrl}/api/v1/tempo/estimate`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${connection.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              path: tempoAudioPath,
              numerator: 4,
              denominator: 4,
            }),
          },
        );
        if (!response.ok) {
          throw new Error(`テンポ解析試験に失敗しました: ${response.status}`);
        }
        const tempo = (await response.json()) as {
          bpm: number;
          beatOffsetSec: number;
        };
        const expectedMeasureOffsetSec = 0.2;
        if (
          tempo.bpm < 110 ||
          tempo.bpm > 130 ||
          Math.abs(tempo.beatOffsetSec - expectedMeasureOffsetSec) >= 0.1
        ) {
          throw new Error(
            `テンポ・拍位置解析が不正です: ${JSON.stringify(tempo)}`,
          );
        }
      }
      console.log("electron-smoke-stage: licenses");
      const aboutInfo = (await window.webContents.executeJavaScript(
        "window.desktopApi.getAboutInfo()",
      )) as {
        appVersion: string;
        engineVersion: string;
        notices: Array<{ name: string; text: string }>;
      };
      const requiredNotices = [
        "EarCopy_Assist_COPYRIGHT.txt",
        "THIRD_PARTY_NOTICES.txt",
        "EarCopy_Assist_LICENSE.txt",
        "THIRD_PARTY_NOTICES.md",
        "THIRD_PARTY_NOTICES.en.md",
        "MuScriptor/LICENSE",
        "MuScriptor/MODEL_NOTICE.txt",
        "MuScriptor/README.md",
        "MuseScore_General/LICENSE.md",
        "MuseScore_General/README.md",
        "MuseScore_General/SAMPLE_SOURCES.csv",
        "MuseScore_General/SOURCE.md",
        "MuseScore_General/VERSION",
        "Backend/ffmpeg/LICENSE",
        "Backend/libsndfile/COPYING",
        "Backend/libsndfile/README.txt",
        "Backend/python/Python-3.11/LICENSE.txt",
        "Backend/python/muscriptor-0.2.2/licenses/LICENSE",
        "SpessaSynth-Core-LICENSE.txt",
        "SpessaSynth-Lib-LICENSE.txt",
      ];
      if (
        !aboutInfo.appVersion ||
        !aboutInfo.engineVersion ||
        requiredNotices.some(
          (name) =>
            !aboutInfo.notices.some(
              (notice) => notice.name === name && notice.text.length > 0,
            ),
        )
      ) {
        throw new Error("バージョン・ライセンス情報が不足しています");
      }
      console.log("electron-smoke-stage: musicxml-preview");
      const musicXmlSmokePath = process.env.EARCOPY_SMOKE_MUSICXML_PATH;
      const musicXmlSmokeContent = musicXmlSmokePath
        ? await readFile(musicXmlSmokePath, "utf8")
        : undefined;
      const musicXmlPreviewResult = (await window.webContents.executeJavaScript(
        `window.runMusicXmlPreviewSmoke(${JSON.stringify(musicXmlSmokeContent)})`,
      )) as {
        svgCount: number;
        graphicalElementCount: number;
        elapsedMs: number;
      };
      if (
        musicXmlPreviewResult.svgCount < 1 ||
        musicXmlPreviewResult.graphicalElementCount < 1
      ) {
        throw new Error(
          `MusicXMLプレビュー描画に失敗しました: ${JSON.stringify(musicXmlPreviewResult)}`,
        );
      }
      console.log(
        `musicxml-preview-smoke: ${JSON.stringify(musicXmlPreviewResult)}`,
      );
      const smokeAudioPath = process.env.EARCOPY_SMOKE_AUDIO_PATH;
      if (smokeAudioPath) {
        console.log("electron-smoke-stage: local-audio");
        const audioUrl = (await window.webContents.executeJavaScript(
          `window.desktopApi.getLocalAudioUrl(${JSON.stringify(smokeAudioPath)})`,
        )) as string;
        const audioReady = (await window.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const audio = new Audio(${JSON.stringify(audioUrl)});
            audio.muted = true;
            audio.addEventListener("canplay", async () => {
              try {
                await audio.play();
                setTimeout(() => {
                  const playing = !audio.paused;
                  audio.pause();
                  resolve(playing);
                }, 50);
              } catch {
                resolve(false);
              }
            }, { once: true });
            audio.addEventListener("error", () => resolve(false), { once: true });
            audio.load();
          })
        `)) as boolean;
        if (!audioReady) {
          throw new Error("ローカル音源を読み込めません");
        }
        const longAudioReady = (await window.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const audio = new Audio(${JSON.stringify(audioUrl)});
            audio.preload = "metadata";
            audio.addEventListener("loadedmetadata", () => {
              if (audio.duration < 1800) {
                resolve(false);
                return;
              }
              audio.currentTime = audio.duration - 1;
            }, { once: true });
            audio.addEventListener("seeked", () => {
              resolve(audio.currentTime >= 1799);
            }, { once: true });
            audio.addEventListener("error", () => resolve(false), { once: true });
            audio.load();
          })
        `)) as boolean;
        if (!longAudioReady) {
          throw new Error("30分音源をストリーミングできません");
        }
        console.log("electron-smoke-stage: soundfont");
        const silentOutput = process.env.CI === "true";
        const soundFontExecution = (await window.webContents.executeJavaScript(`
          window.runSoundFontSmoke(
            ${JSON.stringify(audioUrl)},
            ${JSON.stringify(silentOutput)}
          ).then(
            (value) => ({ ok: true, value }),
            (error) => ({
              ok: false,
              error: {
                name: error?.name ?? error?.constructor?.name ?? "UnknownError",
                message: error?.message ?? String(error),
                code: error?.code,
                stack: error?.stack
              }
            })
          )
        `)) as {
          ok: boolean;
          error?: {
            name?: string;
            message?: string;
            code?: string | number;
            stack?: string;
          };
          value?: {
            ready: boolean;
            directContextOutput: boolean;
            defaultPlaybackRate: number;
            playbackRate: number;
            preservesPitch: boolean;
            firstElapsedSec: number;
            secondElapsedSec: number;
          };
        };
        if (!soundFontExecution.ok || soundFontExecution.value === undefined) {
          throw new Error(
            `SoundFont smoke execution failed: ${JSON.stringify(soundFontExecution.error ?? {})}`,
          );
        }
        const soundFontResult = soundFontExecution.value as {
          ready: boolean;
          directContextOutput: boolean;
          defaultPlaybackRate: number;
          playbackRate: number;
          preservesPitch: boolean;
          firstElapsedSec: number;
          secondElapsedSec: number;
        };
        if (!soundFontResult.ready) {
          throw new Error(
            `SoundFont AudioWorklet再生試験に失敗しました: ${JSON.stringify(soundFontResult)}`,
          );
        }
        console.log(`soundfont-smoke: ${JSON.stringify(soundFontResult)}`);
        console.log("electron-smoke-stage: performance");
        const performanceResult = (await window.webContents.executeJavaScript(
          "window.runPerformanceSmoke()",
        )) as {
          noteCount: number;
          frames: number;
          indexMs: number;
          renderMs: number;
          maxVisible: number;
          followScrollLeft: number | null;
        };
        if (
          performanceResult.noteCount !== 100_000 ||
          performanceResult.frames !== 360 ||
          performanceResult.renderMs > 5_000 ||
          performanceResult.maxVisible < 1 ||
          performanceResult.followScrollLeft !== 800
        ) {
          throw new Error(
            `100,000ノート性能試験に失敗しました: ${JSON.stringify(performanceResult)}`,
          );
        }
        console.log(
          `performance-smoke: ${JSON.stringify(performanceResult)}`,
        );
      }
      if (process.env.EARCOPY_SMOKE_HANG_RENDERER === "1") {
        console.log("electron-smoke-stage: renderer-shutdown");
        await window.webContents.executeJavaScript(`
          setTimeout(() => {
            const deadline = performance.now() + 30_000;
            while (performance.now() < deadline) {
              // Keep Renderer busy so Electron's shutdown deadline is exercised.
            }
          }, 0);
          true;
        `);
        console.log("renderer-hang-smoke-armed");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.log("electron-smoke-ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `新規プロジェクト画面の表示がタイムアウトしました: ${lastState}`,
  );
}

function registerIpc(): void {
  ipcMain.handle("app:quit", () => {
    app.quit();
  });
  ipcMain.handle("service:get-connection", async () => serviceManager.start());
  ipcMain.handle("app:get-about", async () => ({
    appVersion: app.getVersion(),
    engineVersion: "0.2.2",
    notices: await readLicenseNotices(),
  }));
  ipcMain.handle("soundfont:load", async () => {
    const soundFontPath = app.isPackaged
      ? join(process.resourcesPath, "soundfonts", "MuseScore_General.sf3")
      : join(
          currentDirectory,
          "..",
          "resources",
          "soundfonts",
          "MuseScore_General.sf3",
        );
    return new Uint8Array(await readFile(soundFontPath));
  });
  ipcMain.handle(
    "analysis:write-audio",
    async (_event, bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) {
        throw new Error("比較用WAVのデータが不正です");
      }
      if (bytes.byteLength > 250 * 1024 * 1024) {
        throw new Error("比較用WAVは250 MB以下である必要があります");
      }
      const header = Buffer.from(bytes.buffer, bytes.byteOffset, 12);
      if (
        header.toString("ascii", 0, 4) !== "RIFF" ||
        header.toString("ascii", 8, 12) !== "WAVE"
      ) {
        throw new Error("比較用音声はWAV形式である必要があります");
      }
      mkdirSync(spectralAnalysisDirectory, { recursive: true });
      const abandonedFiles = await readdir(spectralAnalysisDirectory, {
        withFileTypes: true,
      });
      const expirationTime = Date.now() - 24 * 60 * 60 * 1_000;
      await Promise.allSettled(
        abandonedFiles
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.startsWith("synth-") &&
              extname(entry.name).toLowerCase() === ".wav",
          )
          .map(async (entry) => {
            const filePath = join(spectralAnalysisDirectory, entry.name);
            if ((await stat(filePath)).mtimeMs < expirationTime) {
              await unlink(filePath);
            }
          }),
      );
      const outputPath = join(
        spectralAnalysisDirectory,
        `synth-${process.pid}-${randomUUID()}.wav`,
      );
      await writeFile(outputPath, bytes);
      return outputPath;
    },
  );
  ipcMain.handle(
    "analysis:delete-audio",
    async (_event, audioPath: string) => {
      const resolvedPath = resolve(audioPath);
      if (
        dirname(resolvedPath) !== resolve(spectralAnalysisDirectory) ||
        extname(resolvedPath).toLowerCase() !== ".wav"
      ) {
        throw new Error("比較用WAVのパスが不正です");
      }
      await unlink(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    },
  );
  ipcMain.handle("audio:get-local-url", async (_event, audioPath: string) => {
    const supported = new Set([
      ".wav",
      ".mp3",
      ".flac",
      ".ogg",
      ".m4a",
      ".aac",
    ]);
    const extension = extname(audioPath).toLowerCase();
    if (!supported.has(extension)) {
      throw new Error(`未対応の音源形式です: ${extension}`);
    }
    const information = await stat(audioPath);
    if (!information.isFile()) {
      throw new Error("音源ファイルが見つかりません");
    }
    return pathToFileURL(audioPath).href;
  });
  ipcMain.handle("dialog:select-audio", async () => {
    const options: OpenDialogOptions = {
      properties: ["openFile"],
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac"],
        },
      ],
    };
    const result = await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("dialog:select-model", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "MuScriptor", extensions: ["safetensors"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("dialog:select-project", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "EarCopy Assist Project", extensions: ["ecaproj"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(
    "dialog:select-export-path",
    async (_event, kind: "midi" | "musicxml") => {
      if (kind !== "midi" && kind !== "musicxml") {
        throw new Error(`未対応の書き出し形式です: ${kind}`);
      }
      const isMidi = kind === "midi";
      const extension = isMidi ? ".mid" : ".musicxml";
      const result = await dialog.showSaveDialog({
        defaultPath: `score${extension}`,
        filters: [
          isMidi
            ? { name: "Standard MIDI File", extensions: ["mid"] }
            : { name: "MusicXML", extensions: ["musicxml"] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }
      return result.filePath.toLowerCase().endsWith(extension)
        ? result.filePath
        : `${result.filePath}${extension}`;
    },
  );
  ipcMain.handle("dialog:select-export-directory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(
    "shell:show-item-in-folder",
    async (_event, filePath: string) => {
      if (
        typeof filePath !== "string" ||
        extname(filePath).toLowerCase() !== ".wav"
      ) {
        throw new Error("WAVファイルを表示できません");
      }
      const information = await stat(filePath);
      if (!information.isFile()) {
        throw new Error("WAVファイルが見つかりません");
      }
      shell.showItemInFolder(filePath);
    },
  );
  ipcMain.handle(
    "dialog:save-project",
    async (_event, defaultName: string, json: string) => {
      const result = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: "EarCopy Assist Project", extensions: ["ecaproj"] }],
      });
      if (result.canceled || !result.filePath) {
        return null;
      }
      const outputPath = result.filePath.toLowerCase().endsWith(".ecaproj")
        ? result.filePath
        : `${result.filePath}.ecaproj`;
      const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temporaryPath, json, "utf8");
        await rename(temporaryPath, outputPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      return outputPath;
    },
  );
}

async function createWindow(): Promise<void> {
  appLogger.log("INFO", "main", "アプリケーションウィンドウを準備します");
  const smokeTest = process.env.EARCOPY_SMOKE_TEST === "1";
  const window = new BrowserWindow({
    show: !smokeTest,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#10131a",
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.on("close", () => {
    startShutdown();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`preload-error: ${preloadPath}: ${error.message}`);
    appLogger.log(
      "ERROR",
      "renderer",
      `preload-error: ${preloadPath}: ${error.stack ?? error.message}`,
    );
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (shutdownDeadline !== null) {
      appLogger.log(
        "INFO",
        "renderer",
        `render-process-gone during shutdown: reason=${details.reason}`,
      );
      return;
    }
    appLogger.log(
      "ERROR",
      "renderer",
      `render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`,
    );
    void showRuntimeFailure(
      "画面処理が停止しました",
      "アプリケーション画面が異常終了しました。",
      `発生時刻: ${new Date().toLocaleString()}\nreason=${details.reason}, exitCode=${details.exitCode}`,
    );
  });
  window.on("unresponsive", () => {
    appLogger.log("WARN", "renderer", "Rendererが応答していません");
  });
  window.on("responsive", () => {
    appLogger.log("INFO", "renderer", "Rendererの応答が回復しました");
  });
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const rendererPath = join(
      currentDirectory,
      "..",
      "dist",
      "renderer",
      "index.html",
    );
    if (smokeTest) {
      await window.loadFile(rendererPath, { query: { smoke: "1" } });
    } else {
      await window.loadFile(rendererPath);
    }
  }
  if (smokeTest) {
    const resultPath = process.env.EARCOPY_SMOKE_RESULT_PATH;
    try {
      await verifySmokeWindow(window);
      if (resultPath) {
        await writeFile(resultPath, "ok", "utf8");
      }
      startShutdown();
    } catch (error) {
      const message = describeSmokeError(error);
      if (resultPath) {
        await writeFile(resultPath, `error\n${message}`, "utf8").catch(
          () => undefined,
        );
      }
      console.error(error);
      appLogger.log("ERROR", "smoke-test", message);
      stopService();
      app.exit(2);
    }
  }
}

async function runShutdownSmokeTest(): Promise<void> {
  const rendererArmed = new Promise<void>((resolve) => {
    ipcMain.once("shutdown-smoke-renderer-armed", () => resolve());
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  });
  await window.loadURL("data:text/html,<title>shutdown smoke</title>");
  void window.webContents.executeJavaScript(`
    require("electron").ipcRenderer.send("shutdown-smoke-renderer-armed");
    setTimeout(() => {
      const shutdownSmokeDeadline = Date.now() + 30_000;
      while (Date.now() < shutdownSmokeDeadline) {}
    }, 100);
  `);
  await rendererArmed;
  await new Promise((resolve) => setTimeout(resolve, 250));
  console.log("renderer-hang-smoke-armed");
  console.log("electron-shutdown-smoke-ready");
  startShutdown();
}

app.whenReady()
  .then(async () => {
    const previousRun = runStateTracker.start();
    appLogger.log(
      "INFO",
      "main",
      `EarCopy Assist ${app.getVersion()}を起動します`,
    );
    if (process.env.EARCOPY_SHUTDOWN_SMOKE_TEST === "1") {
      await runShutdownSmokeTest();
      return;
    }
    registerIpc();
    await createWindow();
    if (previousRun !== null && process.env.EARCOPY_SMOKE_TEST !== "1") {
      appLogger.log(
        "WARN",
        "main",
        (
          "前回の正常終了が記録されていません: " +
          `lastHeartbeat=${previousRun.lastHeartbeat}, pid=${previousRun.pid}`
        ),
      );
      void showRuntimeFailure(
        "前回の異常終了を検出しました",
        "前回のアプリケーションは正常終了を記録していません。",
        `最終生存確認: ${new Date(previousRun.lastHeartbeat).toLocaleString()}`,
      );
    }
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  })
  .catch((error) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(error);
    appLogger.log("ERROR", "main", `起動に失敗しました: ${message}`);
    dialog.showErrorBox("EarCopy Assistを起動できません", message);
    stopService();
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("child-process-gone", (_event, details) => {
  const message =
    `child-process-gone: type=${details.type}, reason=${details.reason}, ` +
    `exitCode=${details.exitCode}, name=${details.name ?? ""}`;
  appLogger.log("ERROR", "electron-child", message);
  if (details.type === "GPU") {
    void showRuntimeFailure(
      "GPU処理が停止しました",
      "ElectronのGPUプロセスが異常終了しました。",
      `発生時刻: ${new Date().toLocaleString()}\n${message}`,
    );
  }
});

app.on("before-quit", () => {
  startShutdown();
});
app.on("will-quit", stopService);
