import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from "electron";
import { ServiceManager } from "./service-manager.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const serviceManager = new ServiceManager();

if (process.env.EARCOPY_SMOKE_TEST === "1") {
  app.commandLine.appendSwitch("in-process-gpu");
  const smokeUserDataPath = process.env.EARCOPY_SMOKE_USER_DATA_PATH;
  if (smokeUserDataPath) {
    app.setPath("userData", smokeUserDataPath);
    app.setPath("sessionData", join(smokeUserDataPath, "session"));
  }
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = (await window.webContents.executeJavaScript(`({
      apiReady: Boolean(
        window.desktopApi &&
        typeof window.desktopApi.getServiceConnection === "function"
      ),
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
      errorText: document.querySelector(".bootstrap-message.is-error")?.textContent ?? ""
    })`)) as {
      apiReady: boolean;
      screenReady: boolean;
      backendReady: boolean;
      modelLabels: string[];
      errorText: string;
    };
    if (!result.apiReady) {
      throw new Error("preloadがdesktopApiを公開していません");
    }
    if (result.errorText) {
      throw new Error(`Renderer初期化エラー: ${result.errorText}`);
    }
    if (result.screenReady) {
      if (!result.backendReady) {
        throw new Error("推論バックエンド選択肢が仕様と一致しません");
      }
      if (
        process.env.EARCOPY_SMOKE_REQUIRE_MODELS === "1" &&
        !["MuScriptor Small", "MuScriptor Large"].every((name) =>
          result.modelLabels.some((label) => label.includes(name)),
        )
      ) {
        throw new Error(
          `MuScriptorモデルが表示されません: ${result.modelLabels.join(", ")}`,
        );
      }
      const settingsReady = (await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "設定"
          );
          if (!button) {
            resolve(false);
            return;
          }
          button.click();
          const deadline = Date.now() + 5000;
          const timer = setInterval(() => {
            const dialog = document.querySelector(".settings-dialog");
            if (dialog) {
              const close = [...dialog.querySelectorAll("button")].find(
                (candidate) => candidate.textContent?.trim() === "閉じる"
              );
              if (close && !close.disabled) {
                clearInterval(timer);
                close.click();
                resolve(Boolean(dialog.textContent?.includes("キャッシュ")));
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
        const connection = await serviceManager.start();
        const response = await fetch(
          `${connection.baseUrl}/api/v1/tempo/estimate`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${connection.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ path: tempoAudioPath }),
          },
        );
        if (!response.ok) {
          throw new Error(`テンポ解析試験に失敗しました: ${response.status}`);
        }
        const tempo = (await response.json()) as {
          bpm: number;
          beatOffsetSec: number;
        };
        if (
          tempo.bpm < 110 ||
          tempo.bpm > 130 ||
          Math.abs(tempo.beatOffsetSec - 0.2) >= 0.1
        ) {
          throw new Error(
            `テンポ・拍位置解析が不正です: ${JSON.stringify(tempo)}`,
          );
        }
      }
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
        "DISTRIBUTION.md",
        "SCNet/LICENSE.md",
        "MuseScore_General/LICENSE.md",
        "Backend/ffmpeg/LICENSE",
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
      const smokeAudioPath = process.env.EARCOPY_SMOKE_AUDIO_PATH;
      if (smokeAudioPath) {
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
        const soundFontResult = (await window.webContents.executeJavaScript(
          `window.runSoundFontSmoke(${JSON.stringify(audioUrl)})`,
        )) as {
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
      console.log("electron-smoke-ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("新規プロジェクト画面の表示がタイムアウトしました");
}

function registerIpc(): void {
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
  await serviceManager.start();
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
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`preload-error: ${preloadPath}: ${error.message}`);
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
      app.quit();
    } catch (error) {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      if (resultPath) {
        await writeFile(resultPath, `error\n${message}`, "utf8").catch(
          () => undefined,
        );
      }
      console.error(error);
      app.exit(2);
    }
  }
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => serviceManager.stop());
