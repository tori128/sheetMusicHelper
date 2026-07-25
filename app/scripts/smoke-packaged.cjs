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
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const executable = resolve(
  process.argv[2] ?? "release/win-unpacked/EarCopyAssist.exe",
);
const executableArgs = process.env.EARCOPY_SMOKE_APP_DIR
  ? [resolve(process.env.EARCOPY_SMOKE_APP_DIR)]
  : [];

if (!existsSync(executable)) {
  console.error(`配布EXEが見つかりません: ${executable}`);
  process.exit(1);
}

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
  const envelope = Math.max(0, 1 - withinBeat / (tempoSampleRate * 0.04));
  const sample = Math.floor(
    16_000 * envelope * Math.sin((2 * Math.PI * 880 * index) / tempoSampleRate),
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
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let result = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
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
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
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
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
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
    result.trim() === "ok" || output.includes("electron-smoke-ready");
  if (code !== 0 || !ready) {
    console.error(
      `配布EXEの起動確認に失敗しました (exit=${code})\n${result}\n${output}`,
    );
    process.exit(code || 2);
  }
  const soundFont = output.match(/soundfont-smoke: (\{[^\r\n]+\})/);
  if (soundFont) {
    console.log(`packaged-${soundFont[0]}`);
  }
  console.log(`packaged-wave-smoke: ${sampleRate} Hz`);
  const performance = output.match(/performance-smoke: (\{[^\r\n]+\})/);
  if (performance) {
    console.log(`packaged-${performance[0]}`);
  }
  console.log("packaged-electron-smoke: ok");
});
