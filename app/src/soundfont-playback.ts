import { WorkletSynthesizer } from "spessasynth_lib";
import workletUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import type { ProjectNote, ProjectTrack } from "./types";

export type PlaybackSource = "original" | "transcription";
export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

export interface SoundFontSmokeResult {
  ready: boolean;
  directContextOutput: boolean;
  defaultPlaybackRate: number;
  playbackRate: number;
  preservesPitch: boolean;
  firstElapsedSec: number;
  secondElapsedSec: number;
}

const SCHEDULER_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.1;
const GAIN_RAMP_SEC = 0.01;
const ORIGINAL_VOLUME_RAMP_STEPS = 5;
const SCHEDULE_EPSILON_SEC = 1e-6;
const NOTE_PREVIEW_DURATION_SEC = 0.4;

type SinkRoutableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

function channelFor(track: ProjectTrack): number {
  return track.midiChannel - 1;
}

export function audibleTrackIds(tracks: ProjectTrack[]): Set<string> {
  const soloTracks = tracks.filter((track) => track.solo);
  const audible = soloTracks.length > 0
    ? soloTracks
    : tracks.filter((track) => !track.mute);
  return new Set(audible.map((track) => track.id));
}

export function normalizeAudioOutputDevices(
  devices: Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[],
): AudioOutputDevice[] {
  return devices
    .filter((device) => device.kind === "audiooutput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `出力デバイス ${index + 1}`,
    }));
}

export function normalizeMediaPlaybackRate(audio: HTMLAudioElement): void {
  audio.defaultPlaybackRate = 1;
  audio.playbackRate = 1;
  audio.preservesPitch = true;
}

export class SoundFontPlaybackEngine {
  readonly #context: AudioContext;
  readonly #synth: WorkletSynthesizer;
  readonly #synthGain: GainNode;
  readonly #audio: HTMLAudioElement;
  readonly #output: HTMLAudioElement | null;
  #trackById = new Map<string, ProjectTrack>();
  #audibleTrackIds = new Set<string>();
  #notes: ProjectNote[] = [];
  #nextNoteIndex = 0;
  #scheduledThroughSec = 0;
  #timer: number | null = null;
  #originalVolumeTimer: number | null = null;
  #previewTimer: number | null = null;
  #previewing = false;
  #source: PlaybackSource = "original";

  private constructor(
    context: AudioContext,
    synth: WorkletSynthesizer,
    audio: HTMLAudioElement,
    output: HTMLAudioElement | null,
    synthGain: GainNode,
  ) {
    this.#context = context;
    this.#synth = synth;
    this.#audio = audio;
    this.#output = output;
    this.#synthGain = synthGain;
  }

  static async create(
    audio: HTMLAudioElement,
    soundFontBytes: Uint8Array,
  ): Promise<SoundFontPlaybackEngine> {
    const context = new AudioContext({ latencyHint: "playback" });
    await context.resume();
    const synthGain = context.createGain();
    const routableContext = context as SinkRoutableAudioContext;
    let output: HTMLAudioElement | null = null;
    if (typeof routableContext.setSinkId === "function") {
      synthGain.connect(context.destination);
    } else {
      const destination = context.createMediaStreamDestination();
      synthGain.connect(destination);
      output = new Audio();
      output.srcObject = destination.stream;
      output.muted = audio.muted;
    }
    normalizeMediaPlaybackRate(audio);
    audio.volume = 1;
    synthGain.gain.value = 0;
    await context.audioWorklet.addModule(workletUrl);
    const synth = new WorkletSynthesizer(context);
    synth.connect(synthGain);
    await synth.isReady;
    const soundFont = soundFontBytes.buffer.slice(
      soundFontBytes.byteOffset,
      soundFontBytes.byteOffset + soundFontBytes.byteLength,
    ) as ArrayBuffer;
    await synth.soundBankManager.addSoundBank(soundFont, "musescore-general");
    return new SoundFontPlaybackEngine(
      context,
      synth,
      audio,
      output,
      synthGain,
    );
  }

  setProject(tracks: ProjectTrack[], notes: ProjectNote[]): void {
    const preserveActivePlayback =
      this.#timer !== null && !this.#audio.paused;
    this.#trackById = new Map(tracks.map((track) => [track.id, track]));
    this.#audibleTrackIds = audibleTrackIds(tracks);
    this.#notes = [...notes].sort(
      (left, right) =>
        left.startSec - right.startSec ||
        left.pitch - right.pitch ||
        left.id.localeCompare(right.id),
    );
    for (const track of tracks) {
      if (track.kind === "pitched" && track.gmProgram !== null) {
        this.#synth.programChange(channelFor(track), track.gmProgram);
      }
    }
    if (preserveActivePlayback) {
      const scheduledThrough = Math.max(
        this.#audio.currentTime,
        this.#scheduledThroughSec,
      );
      const firstUnscheduled = this.#notes.findIndex(
        (note) => note.startSec > scheduledThrough + SCHEDULE_EPSILON_SEC,
      );
      this.#nextNoteIndex =
        firstUnscheduled === -1 ? this.#notes.length : firstUnscheduled;
      return;
    }
    this.seek(this.#audio.currentTime);
  }

  async start(): Promise<void> {
    normalizeMediaPlaybackRate(this.#audio);
    await this.#context.resume();
    await this.#output?.play();
    this.seek(this.#audio.currentTime);
    if (this.#timer === null) {
      this.#timer = window.setInterval(
        () => this.#schedule(),
        SCHEDULER_INTERVAL_MS,
      );
    }
    this.#schedule();
  }

  pause(): void {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#cancelPreview();
    this.#synth.stopAll(true);
  }

  seek(timeSec: number): void {
    this.#synth.stopAll(true);
    this.#resetNextNoteIndex(timeSec);
  }

  async previewNote(track: ProjectTrack, note: ProjectNote): Promise<void> {
    await this.#context.resume();
    this.#cancelPreview();
    const isolatedPreview = this.#source === "original" || this.#audio.paused;
    if (isolatedPreview) {
      this.#synth.stopAll(true);
      this.#previewing = true;
      this.#rampSynthGain(1);
    }
    if (track.kind === "pitched" && track.gmProgram !== null) {
      this.#synth.programChange(channelFor(track), track.gmProgram);
    }
    const now = this.#context.currentTime;
    const channel = channelFor(track);
    this.#synth.noteOn(channel, note.pitch, note.velocity, { time: now });
    this.#synth.noteOff(channel, note.pitch, {
      time: now + NOTE_PREVIEW_DURATION_SEC,
    });
    if (isolatedPreview) {
      this.#previewTimer = window.setTimeout(() => {
        this.#finishPreview();
      }, NOTE_PREVIEW_DURATION_SEC * 1000);
    }
  }

  #resetNextNoteIndex(timeSec: number): void {
    this.#scheduledThroughSec = timeSec;
    const firstRelevant = this.#notes.findIndex(
      (note) => note.endSec > timeSec,
    );
    this.#nextNoteIndex =
      firstRelevant === -1 ? this.#notes.length : firstRelevant;
  }

  setSource(source: PlaybackSource): void {
    this.#cancelPreview();
    this.#source = source;
    const originalTarget = source === "original" ? 1 : 0;
    const synthTarget = source === "transcription" ? 1 : 0;
    this.#rampSynthGain(synthTarget);
    this.#rampOriginalVolume(originalTarget);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if (typeof this.#audio.setSinkId === "function") {
      await this.#audio.setSinkId(deviceId);
    } else if (deviceId && deviceId !== "default") {
      throw new Error("この環境では出力デバイスを選択できません");
    }
    const routableContext = this.#context as SinkRoutableAudioContext;
    if (typeof routableContext.setSinkId === "function") {
      await routableContext.setSinkId(deviceId);
      return;
    }
    if (this.#output !== null && typeof this.#output.setSinkId === "function") {
      await this.#output.setSinkId(deviceId);
      return;
    }
    if (deviceId && deviceId !== "default") {
      throw new Error("この環境では出力デバイスを選択できません");
    }
  }

  async destroy(): Promise<void> {
    this.pause();
    if (this.#originalVolumeTimer !== null) {
      window.clearInterval(this.#originalVolumeTimer);
      this.#originalVolumeTimer = null;
    }
    this.#audio.volume = 1;
    if (this.#output !== null) {
      this.#output.pause();
      this.#output.srcObject = null;
    }
    this.#synth.destroy();
    await this.#context.close();
  }

  #rampOriginalVolume(target: number): void {
    if (this.#originalVolumeTimer !== null) {
      window.clearInterval(this.#originalVolumeTimer);
      this.#originalVolumeTimer = null;
    }
    const initial = this.#audio.volume;
    if (initial === target) {
      return;
    }
    let step = 0;
    const intervalMs =
      (GAIN_RAMP_SEC * 1000) / ORIGINAL_VOLUME_RAMP_STEPS;
    this.#originalVolumeTimer = window.setInterval(() => {
      step += 1;
      const progress = Math.min(1, step / ORIGINAL_VOLUME_RAMP_STEPS);
      this.#audio.volume = initial + (target - initial) * progress;
      if (progress >= 1 && this.#originalVolumeTimer !== null) {
        window.clearInterval(this.#originalVolumeTimer);
        this.#originalVolumeTimer = null;
      }
    }, intervalMs);
  }

  #rampSynthGain(target: number): void {
    const now = this.#context.currentTime;
    const gain = this.#synthGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + GAIN_RAMP_SEC);
  }

  #cancelPreview(): void {
    if (this.#previewTimer !== null) {
      window.clearTimeout(this.#previewTimer);
      this.#previewTimer = null;
    }
    if (this.#previewing) {
      this.#finishPreview();
    }
  }

  #finishPreview(): void {
    if (this.#previewTimer !== null) {
      window.clearTimeout(this.#previewTimer);
      this.#previewTimer = null;
    }
    if (!this.#previewing) {
      return;
    }
    this.#previewing = false;
    this.#synth.stopAll(true);
    this.#rampSynthGain(this.#source === "transcription" ? 1 : 0);
    if (this.#timer !== null) {
      this.#resetNextNoteIndex(this.#audio.currentTime);
    }
  }

  #schedule(): void {
    if (this.#audio.paused || this.#previewing) {
      return;
    }
    const masterTime = this.#audio.currentTime;
    const horizon = masterTime + LOOKAHEAD_SEC;
    this.#scheduledThroughSec = Math.max(this.#scheduledThroughSec, horizon);
    const contextTime = this.#context.currentTime;
    while (this.#nextNoteIndex < this.#notes.length) {
      const note = this.#notes[this.#nextNoteIndex];
      if (note.startSec > horizon) {
        break;
      }
      this.#nextNoteIndex += 1;
      if (
        note.endSec <= masterTime ||
        !this.#audibleTrackIds.has(note.trackId)
      ) {
        continue;
      }
      const track = this.#trackById.get(note.trackId);
      if (track === undefined) {
        continue;
      }
      const channel = channelFor(track);
      const noteOnTime =
        contextTime + Math.max(0, note.startSec - masterTime);
      const noteOffTime =
        contextTime + Math.max(0, note.endSec - masterTime);
      this.#synth.noteOn(channel, note.pitch, note.velocity, {
        time: noteOnTime,
      });
      this.#synth.noteOff(channel, note.pitch, { time: noteOffTime });
    }
  }
}

export async function runSoundFontSmoke(
  audioUrl: string,
): Promise<SoundFontSmokeResult> {
  const audio = new Audio(audioUrl);
  audio.muted = true;
  await new Promise<void>((resolve, reject) => {
    audio.addEventListener("canplay", () => resolve(), { once: true });
    audio.addEventListener("error", () => reject(new Error("音源読込失敗")), {
      once: true,
    });
    audio.load();
  });
  const soundFontBytes = await window.desktopApi.loadSoundFont();
  if (soundFontBytes.byteLength < 1_000_000) {
    return {
      ready: false,
      directContextOutput: false,
      defaultPlaybackRate: audio.defaultPlaybackRate,
      playbackRate: audio.playbackRate,
      preservesPitch: audio.preservesPitch,
      firstElapsedSec: 0,
      secondElapsedSec: 0,
    };
  }
  const directContextOutput =
    typeof (AudioContext.prototype as SinkRoutableAudioContext).setSinkId ===
    "function";
  const engine = await SoundFontPlaybackEngine.create(audio, soundFontBytes);
  try {
    await engine.setOutputDevice("default");
    engine.setProject(
      [
        {
          id: "smoke-track",
          displayName: "Piano",
          instrumentId: "acoustic_piano",
          kind: "pitched",
          color: "#112233",
          order: 1,
          midiChannel: 1,
          gmProgram: 0,
          mute: false,
          solo: false,
        },
      ],
      [
        {
          id: "smoke-note",
          sourceInstrumentId: "acoustic_piano",
          trackId: "smoke-track",
          pitch: 60,
          rawStartSec: 0,
          rawEndSec: 0.05,
          startSec: 0,
          endSec: 0.05,
          velocity: 100,
        },
      ],
    );
    engine.setSource("original");
    audio.defaultPlaybackRate = 0.5;
    audio.playbackRate = 0.5;
    audio.preservesPitch = false;
    normalizeMediaPlaybackRate(audio);
    await audio.play();
    await engine.start();
    const firstStart = audio.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 400));
    audio.pause();
    engine.pause();
    const firstElapsed = audio.currentTime - firstStart;
    audio.defaultPlaybackRate = 0.5;
    audio.playbackRate = 0.5;
    audio.preservesPitch = false;
    normalizeMediaPlaybackRate(audio);
    await audio.play();
    await engine.start();
    const secondStart = audio.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 400));
    audio.pause();
    const secondElapsed = audio.currentTime - secondStart;
    const ready =
      directContextOutput &&
      audio.defaultPlaybackRate === 1 &&
      audio.playbackRate === 1 &&
      audio.preservesPitch &&
      firstElapsed >= 0.2 &&
      firstElapsed <= 0.8 &&
      secondElapsed >= 0.3 &&
      secondElapsed <= 0.8;
    return {
      ready,
      directContextOutput,
      defaultPlaybackRate: audio.defaultPlaybackRate,
      playbackRate: audio.playbackRate,
      preservesPitch: audio.preservesPitch,
      firstElapsedSec: firstElapsed,
      secondElapsedSec: secondElapsed,
    };
  } finally {
    await engine.destroy();
  }
}
