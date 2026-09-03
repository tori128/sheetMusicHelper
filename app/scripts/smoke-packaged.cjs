const {
  existsSync,
  closeSync,
  ftruncateSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PROCESS_COMMAND_TIMEOUT_MS = 3_000;
const MAX_RENDERER_HANG_SHUTDOWN_MS = 3_000;

function terminateProcessTree(processId) {
  return spawnSync(
    "taskkill.exe",
    ["/pid", String(processId), "/T", "/F"],
    {
      windowsHide: true,
      stdio: "ignore",
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
    },
  );
}

function backendProcessIds() {
  if (process.platform !== "win32") {
    return [];
  }
  const result = spawnSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq earcopy_service.exe", "/FO", "CSV", "/NH"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
    },
  );
  return Array.from(
    (result.stdout ?? "").matchAll(/"earcopy_service\.exe","(\d+)"/gi),
    (match) => Number.parseInt(match[1], 10),
  );
}

function waitForNewBackendProcessesToExit(existingProcessIds) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  let remaining = [];
  do {
    remaining = backendProcessIds().filter(
      (processId) => !existingProcessIds.has(processId),
    );
    if (remaining.length === 0) {
      return [];
    }
    Atomics.wait(waitArray, 0, 0, 100);
  } while (Date.now() < deadline);
  return remaining;
}

const executable = resolve(
  process.argv[2] ?? "release/win-unpacked/EarCopyAssist.exe",
);
const executableArgs = process.env.EARCOPY_SMOKE_APP_DIR
  ? [resolve(process.env.EARCOPY_SMOKE_APP_DIR)]
  : [];
const existingBackendProcessIds = new Set(backendProcessIds());

if (!existsSync(executable)) {
  console.error(`配布EXEが見つかりません: ${executable}`);
  process.exit(1);
}

const expectedSoundFontHash =
  "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3";
const soundFontPath = join(
  dirname(executable),
  "resources",
  "soundfonts",
  "MuseScore_General.sf3",
);
if (!existsSync(soundFontPath)) {
  console.error(`配布SoundFontが見つかりません: ${soundFontPath}`);
  process.exit(1);
}
const soundFontHash = createHash("sha256")
  .update(readFileSync(soundFontPath))
  .digest("hex");
if (soundFontHash !== expectedSoundFontHash) {
  console.error(
    `配布SoundFontのSHA-256が不正です: ${soundFontHash}`,
  );
  process.exit(1);
}
console.log(`packaged-soundfont-hash: ${soundFontHash}`);

const bundledStemWeightPath = join(
  dirname(executable),
  "resources",
  "models",
  "bs-roformer",
  "sw-fixed",
  "BS-Rofo-SW-Fixed.ckpt",
);
if (existsSync(bundledStemWeightPath)) {
  console.error(
    `分離モデル重みが配布物内部に含まれています: ${bundledStemWeightPath}`,
  );
  process.exit(1);
}
console.log("packaged-stem-weight: absent");

const bundledMuScriptorVariants = ["small", "medium", "large"];
for (const variant of bundledMuScriptorVariants) {
  const variantRoot = join(
    dirname(executable),
    "resources",
    "models",
    "muscriptor",
    variant,
  );
  const weightPath = join(variantRoot, "model.safetensors");
  const configPath = join(variantRoot, "config.json");
  if (existsSync(weightPath) || existsSync(configPath)) {
    console.error(`MuScriptor ${variant}が本体アーカイブに含まれています: ${variantRoot}`);
    process.exit(1);
  }
}
console.log("packaged-muscriptor-models: absent");

const resultPath = join(
  tmpdir(),
  `earcopy-smoke-${process.pid}-${Date.now()}.txt`,
);
const userDataPath = `${resultPath}.user-data`;
const audioPath = join(
  tmpdir(),
  `earcopy-smoke-${process.pid}-${Date.now()}.wav`,
);
const tempoAudioPath = join(
  tmpdir(),
  `earcopy-tempo-smoke-${process.pid}-${Date.now()}.wav`,
);
const sampleRate = Number.parseInt(
  process.env.EARCOPY_SMOKE_SAMPLE_RATE ?? "8000",
  10,
);
if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
  console.error(`試験用サンプルレートが不正です: ${sampleRate}`);
  process.exit(1);
}
const durationSec = 1_801;
const sampleCount = sampleRate * durationSec;
const wave = Buffer.alloc(44);
wave.write("RIFF", 0);
wave.writeUInt32LE(36 + sampleCount * 2, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write("data", 36);
wave.writeUInt32LE(sampleCount * 2, 40);
const audioFile = openSync(audioPath, "w");
writeSync(audioFile, wave);
ftruncateSync(audioFile, 44 + sampleCount * 2);
closeSync(audioFile);

const tempoSampleRate = 44_100;
const tempoDurationSec = 6;
const tempoSampleCount = tempoSampleRate * tempoDurationSec;
const tempoWave = Buffer.alloc(44 + tempoSampleCount * 2);
tempoWave.write("RIFF", 0);
tempoWave.writeUInt32LE(36 + tempoSampleCount * 2, 4);
tempoWave.write("WAVEfmt ", 8);
tempoWave.writeUInt32LE(16, 16);
tempoWave.writeUInt16LE(1, 20);
tempoWave.writeUInt16LE(1, 22);
tempoWave.writeUInt32LE(tempoSampleRate, 24);
tempoWave.writeUInt32LE(tempoSampleRate * 2, 28);
tempoWave.writeUInt16LE(2, 32);
tempoWave.writeUInt16LE(16, 34);
tempoWave.write("data", 36);
tempoWave.writeUInt32LE(tempoSampleCount * 2, 40);
const tempoOffsetSamples = Math.floor(tempoSampleRate * 0.2);
const tempoPeriodSamples = Math.floor(tempoSampleRate * 0.5);
for (let index = tempoOffsetSamples; index < tempoSampleCount; index += 1) {
  const withinBeat = (index - tempoOffsetSamples) % tempoPeriodSamples;
  const beatIndex = Math.floor(
    (index - tempoOffsetSamples) / tempoPeriodSamples,
  );
  const envelope = Math.max(0, 1 - withinBeat / (tempoSampleRate * 0.04));
  const downbeat =
    beatIndex % 4 === 0
      ? 14_000 * Math.sin((2 * Math.PI * 80 * index) / tempoSampleRate)
      : 0;
  const sample = Math.floor(
    envelope *
      (10_000 * Math.sin((2 * Math.PI * 880 * index) / tempoSampleRate) +
        downbeat),
  );
  tempoWave.writeInt16LE(sample, 44 + index * 2);
}
writeFileSync(tempoAudioPath, tempoWave);

const child = spawn(executable, executableArgs, {
  env: {
    ...process.env,
    EARCOPY_SMOKE_TEST: "1",
    EARCOPY_SMOKE_RESULT_PATH: resultPath,
    EARCOPY_SMOKE_USER_DATA_PATH: userDataPath,
    EARCOPY_SMOKE_AUDIO_PATH: audioPath,
    EARCOPY_SMOKE_TEMPO_AUDIO_PATH: tempoAudioPath,
    ...(process.env.EARCOPY_SMOKE_MUSICXML_PATH
      ? { EARCOPY_SMOKE_MUSICXML_PATH: process.env.EARCOPY_SMOKE_MUSICXML_PATH }
      : {}),
    EARCOPY_SMOKE_HANG_RENDERER: "1",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let result = "";
let shutdownStartedAt = null;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  if (shutdownStartedAt === null && text.includes("electron-smoke-ready")) {
    shutdownStartedAt = Date.now();
  }
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

const poll = setInterval(() => {
  if (existsSync(resultPath)) {
    result = readFileSync(resultPath, "utf8");
    if (result.startsWith("error\n")) {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        terminateProcessTree(child.pid);
      }
      cleanup();
      console.error(`配布EXEの起動確認に失敗しました\n${result}\n${output}`);
      process.exit(2);
    }
  }
}, 250);

function cleanup() {
  clearInterval(poll);
  try {
    rmSync(userDataPath, { recursive: true, force: true });
  } catch {
    // Electronの終了直後にキャッシュファイルが解放されていない場合がある。
  }
  for (const path of [resultPath, audioPath, tempoAudioPath]) {
    try {
      unlinkSync(path);
    } catch {
      // 一時ファイルがまだ作成されていない場合は何もしない。
    }
  }
}

const timer = setTimeout(() => {
  if (child.pid !== undefined) {
    terminateProcessTree(child.pid);
  }
  cleanup();
  console.error(
    `配布EXEの起動確認がタイムアウトしました\n${result}\n${output}`,
  );
  process.exit(2);
}, 240_000);

child.on("error", (error) => {
  clearTimeout(timer);
  cleanup();
  console.error(error);
  process.exit(1);
});

child.on("exit", (code) => {
  clearTimeout(timer);
  if (existsSync(resultPath)) {
    result = readFileSync(resultPath, "utf8");
  }
  cleanup();
  const ready =
    (result.trim() === "ok" || output.includes("electron-smoke-ready")) &&
    output.includes("renderer-hang-smoke-armed");
  const shutdownElapsedMs =
    shutdownStartedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - shutdownStartedAt;
  const remainingBackendProcessIds =
    waitForNewBackendProcessesToExit(existingBackendProcessIds);
  if (remainingBackendProcessIds.length > 0) {
    for (const processId of remainingBackendProcessIds) {
      terminateProcessTree(processId);
    }
  }
  if (
    code !== 0 ||
    !ready ||
    shutdownElapsedMs > MAX_RENDERER_HANG_SHUTDOWN_MS ||
    remainingBackendProcessIds.length > 0
  ) {
    console.error(
      `配布EXEの起動確認に失敗しました (exit=${code}, shutdownMs=${shutdownElapsedMs}, remainingBackendPids=${remainingBackendProcessIds.join(",")})\n${result}\n${output}`,
    );
    process.exit(code || 2);
  }
  const soundFont = output.match(/soundfont-smoke: (\{[^\r\n]+\})/);
  if (soundFont) {
    console.log(`packaged-${soundFont[0]}`);
  }
  const musicXmlPreview = output.match(
    /musicxml-preview-smoke: (\{[^\r\n]+\})/,
  );
  if (!musicXmlPreview) {
    console.error("MusicXMLプレビュー試験結果を取得できません");
    process.exit(1);
  }
  console.log(`packaged-${musicXmlPreview[0]}`);
  console.log(`packaged-wave-smoke: ${sampleRate} Hz`);
  const performance = output.match(/performance-smoke: (\{[^\r\n]+\})/);
  if (performance) {
    console.log(`packaged-${performance[0]}`);
  }
  console.log(
    `packaged-renderer-hang-shutdown-smoke: ${shutdownElapsedMs} ms`,
  );
  console.log("packaged-electron-smoke: ok");
});
