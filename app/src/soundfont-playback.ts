import { MIDIBuilder } from "spessasynth_core";
import { Sequencer, WorkletSynthesizer } from "spessasynth_lib";
import workletUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import {
  PlaybackAudioOutput,
  supportsDirectAudioOutput,
  type PlaybackAudioOutputGraph,
} from "./playback-audio-output";
import {
  contextTimeForTimelineTime,
  timelineTimeAtContextTime,
  type TimelinePlaybackStartAnchor,
} from "./playback-transport";
import { resolveNoteOverlaps } from "./store/project-editing";
import { trackMidiVolume } from "./track-playback-volume";
import type { ProjectNote, ProjectTrack } from "./types";

export type PlaybackSource = "original" | "transcription" | "comparison";
export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

export interface MetronomeSettings {
  enabled: boolean;
  bpm: number;
  beatOffsetSec: number;
  timeSignature: {
    numerator: number;
    denominator: number;
  };
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

const SCHEDULER_INTERVAL_MS = 20;
const LOOKAHEAD_SEC = 0.35;
const GAIN_RAMP_SEC = 0.01;
const SCHEDULE_EPSILON_SEC = 1e-6;
const TRANSCRIPTION_VOICE_CAP = 128;
const METRONOME_VOICE_CAP = 16;
const METRONOME_MIDI_CHANNEL = 9;
const METRONOME_ACCENT_PITCH = 76;
const METRONOME_REGULAR_PITCH = 77;
const METRONOME_NOTE_LENGTH_SEC = 0.05;
const SCHEDULE_CANCEL_DELAY_SEC = 0.001;
const PREVIEW_MIDI_CHANNEL = 16;
const MAX_TRANSCRIPTION_DELAY_SEC = 0.2;
export const NOTE_PREVIEW_MINIMUM_DURATION_MS = 400;

interface SoundFontPlaybackCreateOptions {
  silentOutput?: boolean;
}

interface PendingNoteEnd {
  channel: number;
  pitch: number;
  startContextTime: number;
}

interface ScheduledNoteOn {
  channel: number;
  pitch: number;
  contextTime: number;
}

interface ScheduledMetronomeClick {
  pitch: number;
  contextTime: number;
}

interface SoundFontVoiceRequirement {
  key: string;
  drums: boolean;
  program: number;
  pitch: number;
  velocity: number;
}

interface SoundFontVoicePreloadMIDIData {
  binary: ArrayBuffer;
  fileName: string;
}

function channelFor(track: ProjectTrack): number {
  return track.midiChannel - 1;
}

function playbackPitch(track: ProjectTrack, pitch: number): number {
  if (track.kind !== "pitched") {
    return pitch;
  }
  return Math.max(
    0,
    Math.min(127, pitch + track.playbackOctaveShift * 12),
  );
}

export function soundFontVoiceRequirements(
  tracks: ProjectTrack[],
  notes: ProjectNote[],
): Map<string, SoundFontVoiceRequirement> {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const requirements = new Map<string, SoundFontVoiceRequirement>();
  for (const note of notes) {
    const track = trackById.get(note.trackId);
    if (track === undefined) {
      continue;
    }
    const drums = track.kind === "drums";
    const program = drums ? 0 : (track.gmProgram ?? 0);
    const pitch = playbackPitch(track, note.pitch);
    const key = `${drums ? "drums" : `program:${program}`}:${pitch}:${note.velocity}`;
    requirements.set(key, {
      key,
      drums,
      program,
      pitch,
      velocity: note.velocity,
    });
  }
  return requirements;
}

function buildVoicePreloadMIDIs(
  requirements: SoundFontVoiceRequirement[],
): SoundFontVoicePreloadMIDIData[] {
  const requirementsByPreset = new Map<
    string,
    SoundFontVoiceRequirement[]
  >();
  for (const requirement of requirements) {
    const presetKey = requirement.drums
      ? "drums"
      : `program:${requirement.program}`;
    const presetRequirements = requirementsByPreset.get(presetKey) ?? [];
    presetRequirements.push(requirement);
    requirementsByPreset.set(presetKey, presetRequirements);
  }

  return [...requirementsByPreset.entries()].map(
    ([presetKey, presetRequirements]) => {
      const midi = new MIDIBuilder({
        format: 1,
        name: `voice-preload-${presetKey}`,
      });
      midi.addTrack("voice-preload");
      const midiTrack = 1;
      const channel = presetRequirements[0].drums ? 9 : 0;
      midi.programChange(
        0,
        midiTrack,
        channel,
        presetRequirements[0].program,
      );
      presetRequirements.sort(
        (left, right) =>
          left.pitch - right.pitch || left.velocity - right.velocity,
      );
      for (const requirement of presetRequirements) {
        midi.noteOn(
          1,
          midiTrack,
          channel,
          requirement.pitch,
          requirement.velocity,
        );
        midi.noteOff(2, midiTrack, channel, requirement.pitch);
      }
      midi.flush();
      return {
        binary: midi.writeMIDI(),
        fileName: `voice-preload-${presetKey}.mid`,
      };
    },
  );
}

async function preloadSoundFontVoices(
  sequencer: Sequencer,
  requirements: SoundFontVoiceRequirement[],
): Promise<void> {
  if (requirements.length === 0) {
    return;
  }
  sequencer.loadNewSongList(buildVoicePreloadMIDIs(requirements));
  await sequencer.getMIDI();
}

export function audibleTrackIds(tracks: ProjectTrack[]): Set<string> {
  const soloTracks = tracks.filter((track) => track.solo);
  const audible = soloTracks.length > 0
    ? soloTracks.filter((track) => !track.mute)
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

export function sourceTimeToTimelineTime(
  sourceTimeSec: number,
  timelineOffsetSec: number,
): number {
  return Math.max(0, sourceTimeSec + timelineOffsetSec);
}

export function resolveTimelineSeek(
  timelineTimeSec: number,
  timelineOffsetSec: number,
  sourceDurationSec: number,
): { sourceTimeSec: number; timelineTimeSec: number } {
  const sourceTimeSec = Math.min(
    Math.max(0, sourceDurationSec),
    Math.max(0, timelineTimeSec - timelineOffsetSec),
  );
  return {
    sourceTimeSec,
    timelineTimeSec: sourceTimeToTimelineTime(
      sourceTimeSec,
      timelineOffsetSec,
    ),
  };
}

export class SoundFontPlaybackEngine {
  readonly #context: AudioContext;
  readonly #synth: WorkletSynthesizer;
  readonly #metronomeSynth: WorkletSynthesizer;
  readonly #voicePreloadSequencer: Sequencer;
  readonly #synthBus: GainNode;
  readonly #playbackDelay: DelayNode;
  readonly #synthGain: GainNode;
  readonly #comparisonMonoBus: GainNode;
  readonly #rightPanner: StereoPannerNode;
  readonly #comparisonGain: GainNode;
  readonly #metronomeGain: GainNode;
  readonly #audio: HTMLAudioElement;
  readonly #audioOutput: PlaybackAudioOutputGraph;
  readonly #ownsAudioOutput: boolean;
  #trackById = new Map<string, ProjectTrack>();
  #audibleTrackIds = new Set<string>();
  #notes: ProjectNote[] = [];
  #notesByEnd: ProjectNote[] = [];
  #nextNoteIndex = 0;
  #nextNoteEndIndex = 0;
  #pendingNoteEnds = new Map<string, PendingNoteEnd>();
  #suppressedNoteEndIds = new Set<string>();
  #scheduledNoteOns = new Map<string, ScheduledNoteOn>();
  #scheduledMetronomeClicks: ScheduledMetronomeClick[] = [];
  #scheduledThroughSec = 0;
  #timer: number | null = null;
  #activePreview: { channel: number; pitch: number } | null = null;
  #previewStartedAtSec = 0;
  #previewReleaseTimer: number | null = null;
  #metronome: MetronomeSettings = {
    enabled: false,
    bpm: 120,
    beatOffsetSec: 0,
    timeSignature: { numerator: 4, denominator: 4 },
  };
  #nextMetronomeBeatIndex = 0;
  #previewing = false;
  #transportSilenced = false;
  #source: PlaybackSource = "original";
  #timelineOffsetSec = 0;
  #transportAnchor: TimelinePlaybackStartAnchor | null = null;
  #transportRunning = false;
  #requiredSoundFontVoices = new Map<string, SoundFontVoiceRequirement>();
  #preloadedSoundFontVoiceKeys = new Set<string>();
  #voicePreloadPromise: Promise<void> | null = null;

  private constructor(
    context: AudioContext,
    synth: WorkletSynthesizer,
    metronomeSynth: WorkletSynthesizer,
    voicePreloadSequencer: Sequencer,
    audio: HTMLAudioElement,
    audioOutput: PlaybackAudioOutputGraph,
    ownsAudioOutput: boolean,
    synthBus: GainNode,
    playbackDelay: DelayNode,
    synthGain: GainNode,
    comparisonMonoBus: GainNode,
    rightPanner: StereoPannerNode,
    comparisonGain: GainNode,
    metronomeGain: GainNode,
  ) {
    this.#context = context;
    this.#synth = synth;
    this.#metronomeSynth = metronomeSynth;
    this.#voicePreloadSequencer = voicePreloadSequencer;
    this.#audio = audio;
    this.#audioOutput = audioOutput;
    this.#ownsAudioOutput = ownsAudioOutput;
    this.#synthBus = synthBus;
    this.#playbackDelay = playbackDelay;
    this.#synthGain = synthGain;
    this.#comparisonMonoBus = comparisonMonoBus;
    this.#rightPanner = rightPanner;
    this.#comparisonGain = comparisonGain;
    this.#metronomeGain = metronomeGain;
  }

  static async create(
    audio: HTMLAudioElement,
    soundFontBytes: Uint8Array,
    options: SoundFontPlaybackCreateOptions = {},
    sharedAudioOutput?: PlaybackAudioOutputGraph,
  ): Promise<SoundFontPlaybackEngine> {
    const audioOutput =
      sharedAudioOutput ?? await PlaybackAudioOutput.create(audio, options);
    const ownsAudioOutput = sharedAudioOutput === undefined;
    const context = audioOutput.context;
    const synthBus = context.createGain();
    const playbackDelay = context.createDelay(MAX_TRANSCRIPTION_DELAY_SEC);
    playbackDelay.delayTime.value = 0;
    const synthGain = context.createGain();
    const comparisonMonoBus = context.createGain();
    comparisonMonoBus.channelCount = 1;
    comparisonMonoBus.channelCountMode = "explicit";
    comparisonMonoBus.channelInterpretation = "speakers";
    const rightPanner = context.createStereoPanner();
    rightPanner.pan.value = 1;
    const comparisonGain = context.createGain();
    const metronomeGain = context.createGain();
    const destination = audioOutput.destination;
    synthBus.connect(playbackDelay);
    playbackDelay.connect(synthGain);
    synthGain.connect(destination);
    playbackDelay.connect(comparisonMonoBus);
    comparisonMonoBus.connect(rightPanner);
    rightPanner.connect(comparisonGain);
    comparisonGain.connect(destination);
    metronomeGain.connect(destination);
    normalizeMediaPlaybackRate(audio);
    synthGain.gain.value = 0;
    comparisonGain.gain.value = 0;
    metronomeGain.gain.value = 0;
    await context.audioWorklet.addModule(workletUrl);
    const synth = new WorkletSynthesizer(context, {
      eventsEnabled: false,
    });
    const metronomeSynth = new WorkletSynthesizer(context, {
      eventsEnabled: false,
    });
    synth.connect(synthBus);
    metronomeSynth.connect(metronomeGain);
    await Promise.all([synth.isReady, metronomeSynth.isReady]);
    synth.addNewChannel();
    synth.setSystemParameter("effectsEnabled", false);
    synth.setSystemParameter("autoAllocateVoices", false);
    synth.setSystemParameter("voiceCap", TRANSCRIPTION_VOICE_CAP);
    metronomeSynth.setSystemParameter("effectsEnabled", false);
    metronomeSynth.setSystemParameter("voiceCap", METRONOME_VOICE_CAP);
    const soundFont = soundFontBytes.buffer.slice(
      soundFontBytes.byteOffset,
      soundFontBytes.byteOffset + soundFontBytes.byteLength,
    ) as ArrayBuffer;
    const metronomeSoundFont = soundFontBytes.buffer.slice(
      soundFontBytes.byteOffset,
      soundFontBytes.byteOffset + soundFontBytes.byteLength,
    ) as ArrayBuffer;
    await Promise.all([
      synth.soundBankManager.addSoundBank(soundFont, "musescore-general"),
      metronomeSynth.soundBankManager.addSoundBank(
        metronomeSoundFont,
        "musescore-general",
      ),
    ]);
    const voicePreloadSequencer = new Sequencer(synth, {
      skipToFirstNoteOn: false,
    });
    const metronomeVoicePreloadSequencer = new Sequencer(
      metronomeSynth,
      { skipToFirstNoteOn: false },
    );
    await preloadSoundFontVoices(
      metronomeVoicePreloadSequencer,
      [
        {
          key: `drums:${METRONOME_ACCENT_PITCH}:118`,
          drums: true,
          program: 0,
          pitch: METRONOME_ACCENT_PITCH,
          velocity: 118,
        },
        {
          key: `drums:${METRONOME_REGULAR_PITCH}:92`,
          drums: true,
          program: 0,
          pitch: METRONOME_REGULAR_PITCH,
          velocity: 92,
        },
      ],
    );
    return new SoundFontPlaybackEngine(
      context,
      synth,
      metronomeSynth,
      voicePreloadSequencer,
      audio,
      audioOutput,
      ownsAudioOutput,
      synthBus,
      playbackDelay,
      synthGain,
      comparisonMonoBus,
      rightPanner,
      comparisonGain,
      metronomeGain,
    );
  }

  setProject(tracks: ProjectTrack[], notes: ProjectNote[]): void {
    const preserveActivePlayback =
      this.#timer !== null && !this.#audio.paused;
    const nextTrackById = new Map(tracks.map((track) => [track.id, track]));
    const nextAudibleTrackIds = audibleTrackIds(tracks);
    const resolvedNotes = resolveNoteOverlaps(notes);
    if (preserveActivePlayback) {
      const nextNoteById = new Map(
        resolvedNotes.map((note) => [note.id, note]),
      );
      for (const [id, pending] of this.#pendingNoteEnds) {
        const nextNote = nextNoteById.get(id);
        const nextTrack =
          nextNote === undefined
            ? undefined
            : nextTrackById.get(nextNote.trackId);
        if (
          nextNote !== undefined &&
          nextTrack !== undefined &&
          nextAudibleTrackIds.has(nextNote.trackId) &&
          channelFor(nextTrack) === pending.channel &&
          playbackPitch(nextTrack, nextNote.pitch) === pending.pitch
        ) {
          continue;
        }
        const stopTime =
          Math.max(this.#context.currentTime, pending.startContextTime) +
          SCHEDULE_CANCEL_DELAY_SEC;
        this.#synth.noteOff(pending.channel, pending.pitch, {
          time: stopTime,
        });
        this.#pendingNoteEnds.delete(id);
        this.#scheduledNoteOns.delete(id);
      }
    }
    this.#trackById = nextTrackById;
    this.#audibleTrackIds = nextAudibleTrackIds;
    this.#notes = resolvedNotes;
    this.#requiredSoundFontVoices = soundFontVoiceRequirements(
      tracks,
      resolvedNotes,
    );
    this.#notesByEnd = [...this.#notes].sort(
      (left, right) =>
        left.endSec - right.endSec ||
        left.startSec - right.startSec ||
        left.id.localeCompare(right.id),
    );
    this.#applyTrackSettings();
    if (preserveActivePlayback) {
      const scheduledThrough = Math.max(
        this.currentTimelineTime(),
        this.#scheduledThroughSec,
      );
      const firstUnscheduled = this.#notes.findIndex(
        (note) => note.startSec > scheduledThrough + SCHEDULE_EPSILON_SEC,
      );
      this.#nextNoteIndex =
        firstUnscheduled === -1 ? this.#notes.length : firstUnscheduled;
      const firstUnscheduledEnd = this.#notesByEnd.findIndex(
        (note) => note.endSec > scheduledThrough + SCHEDULE_EPSILON_SEC,
      );
      this.#nextNoteEndIndex =
        firstUnscheduledEnd === -1
          ? this.#notesByEnd.length
          : firstUnscheduledEnd;
      this.#suppressedNoteEndIds = new Set(
        this.#notes
          .filter(
            (note) =>
              note.startSec <= scheduledThrough + SCHEDULE_EPSILON_SEC &&
              note.endSec > scheduledThrough + SCHEDULE_EPSILON_SEC &&
              !this.#pendingNoteEnds.has(note.id),
          )
          .map((note) => note.id),
      );
      return;
    }
    this.seek(this.currentTimelineTime());
  }

  async start(): Promise<void> {
    normalizeMediaPlaybackRate(this.#audio);
    await this.prepare();
    const contextTimeSec = this.#context.currentTime;
    const sourceTimeSec = this.#audio.currentTime;
    this.startAt({
      contextTimeSec,
      sourceTimeSec,
      timelineTimeSec: sourceTimeToTimelineTime(
        sourceTimeSec,
        this.#timelineOffsetSec,
      ),
      audibleContextTimeSec: contextTimeSec,
    });
  }

  startAt(anchor: TimelinePlaybackStartAnchor): void {
    normalizeMediaPlaybackRate(this.#audio);
    this.#resetSchedule(anchor.timelineTimeSec);
    this.#transportAnchor = anchor;
    this.#transportRunning = true;
    if (this.#timer === null) {
      this.#timer = window.setInterval(
        () => this.#schedule(),
        SCHEDULER_INTERVAL_MS,
      );
    }
    this.#transportSilenced = false;
    this.#updateSynthRoutingAt(anchor.audibleContextTimeSec);
    this.#setMetronomeGainAt(
      this.#metronome.enabled ? 1 : 0,
      anchor.audibleContextTimeSec,
    );
    this.#schedule();
  }

  pause(): void {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#transportSilenced = true;
    this.#transportRunning = false;
    this.#silencePlaybackGains();
    this.stopNotePreview();
    this.#stopMetronomeClicks();
    this.#cancelScheduledNoteOns();
    this.#synth.stopAll(true);
    this.#pendingNoteEnds.clear();
    this.#transportAnchor = null;
  }

  seek(timeSec: number): void {
    this.#resetSchedule(timeSec);
    if (this.#timer !== null && this.#transportRunning) {
      const contextTimeSec = this.#context.currentTime;
      this.#transportAnchor = {
        contextTimeSec,
        sourceTimeSec: this.#audio.currentTime,
        timelineTimeSec: timeSec,
        audibleContextTimeSec: contextTimeSec,
      };
      this.#schedule();
    } else {
      this.#transportAnchor = null;
    }
  }

  #resetSchedule(timeSec: number): void {
    this.#stopMetronomeClicks();
    this.#cancelScheduledNoteOns();
    this.#synth.stopAll(true);
    this.#resetNextNoteIndex(timeSec);
    this.#resetMetronomeBeatIndex(timeSec);
  }

  setTimelineOffset(timelineOffsetSec: number): void {
    if (!Number.isFinite(timelineOffsetSec)) {
      throw new Error("原音のタイムライン位置が不正です");
    }
    if (this.#timelineOffsetSec === timelineOffsetSec) {
      return;
    }
    this.#timelineOffsetSec = timelineOffsetSec;
    this.seek(
      sourceTimeToTimelineTime(
        this.#audio.currentTime,
        this.#timelineOffsetSec,
      ),
    );
  }

  async startNotePreview(
    track: ProjectTrack,
    note: ProjectNote,
  ): Promise<void> {
    await this.prepare();
    await this.#context.resume();
    this.stopNotePreview();
    const isolatedPreview = this.#source === "original" || this.#audio.paused;
    if (isolatedPreview) {
      this.#synth.stopAll(true);
      this.#previewing = true;
      this.#rampGain(this.#synthGain, 1);
      this.#rampGain(this.#comparisonGain, 0);
    }
    if (track.kind === "pitched" && track.gmProgram !== null) {
      this.#synth.midiChannels[PREVIEW_MIDI_CHANNEL]?.setDrums(false);
      this.#synth.programChange(PREVIEW_MIDI_CHANNEL, track.gmProgram);
    } else {
      this.#synth.midiChannels[PREVIEW_MIDI_CHANNEL]?.setDrums(true);
    }
    const now = this.#context.currentTime;
    const channel = PREVIEW_MIDI_CHANNEL;
    const volume = trackMidiVolume(track);
    this.#synth.controllerChange(channel, volume.controller, volume.value);
    const pitch = playbackPitch(track, note.pitch);
    this.#activePreview = { channel, pitch };
    this.#previewStartedAtSec = now;
    this.#synth.noteOn(channel, pitch, note.velocity, { time: now });
  }

  releaseNotePreview(): void {
    if (this.#activePreview === null || this.#previewReleaseTimer !== null) {
      return;
    }
    const elapsedSec = this.#context.currentTime - this.#previewStartedAtSec;
    const remainingMs =
      NOTE_PREVIEW_MINIMUM_DURATION_MS - elapsedSec * 1000;
    if (remainingMs <= 0) {
      this.stopNotePreview();
      return;
    }
    this.#previewReleaseTimer = window.setTimeout(() => {
      this.#previewReleaseTimer = null;
      this.stopNotePreview();
    }, remainingMs);
  }

  stopNotePreview(): void {
    if (this.#previewReleaseTimer !== null) {
      window.clearTimeout(this.#previewReleaseTimer);
      this.#previewReleaseTimer = null;
    }
    if (this.#activePreview !== null) {
      const { channel, pitch } = this.#activePreview;
      this.#activePreview = null;
      this.#synth.noteOff(channel, pitch, {
        time: this.#context.currentTime,
      });
    }
    if (this.#previewing) {
      this.#finishPreview();
    }
  }

  #resetNextNoteIndex(timeSec: number): void {
    this.#pendingNoteEnds.clear();
    this.#scheduledThroughSec = timeSec;
    const firstRelevant = this.#notes.findIndex(
      (note) => note.startSec >= timeSec - SCHEDULE_EPSILON_SEC,
    );
    this.#nextNoteIndex =
      firstRelevant === -1 ? this.#notes.length : firstRelevant;
    this.#suppressedNoteEndIds = new Set(
      this.#notes
        .filter(
          (note) =>
            note.startSec < timeSec - SCHEDULE_EPSILON_SEC &&
            note.endSec > timeSec + SCHEDULE_EPSILON_SEC,
        )
        .map((note) => note.id),
    );
    const firstEndingAfter = this.#notesByEnd.findIndex(
      (note) => note.endSec > timeSec + SCHEDULE_EPSILON_SEC,
    );
    this.#nextNoteEndIndex =
      firstEndingAfter === -1
        ? this.#notesByEnd.length
        : firstEndingAfter;
  }

  async prepare(): Promise<void> {
    await this.#audioOutput.start();
    await this.#ensureRequiredSoundFontVoicesPreloaded();
  }

  setSource(source: PlaybackSource): void {
    this.stopNotePreview();
    const sourceChanged = this.#source !== source;
    this.#source = source;
    if (source !== "original") {
      if (sourceChanged) {
        this.#cancelScheduledNoteOns();
        this.#synth.stopAll(true);
        this.#resetNextNoteIndex(this.currentTimelineTime());
      }
    } else if (sourceChanged) {
      this.#cancelScheduledNoteOns();
      this.#synth.stopAll(true);
    }
    this.#updateSynthRouting();
  }

  setMetronome(settings: MetronomeSettings): void {
    if (
      !Number.isFinite(settings.bpm) ||
      settings.bpm <= 0 ||
      !Number.isFinite(settings.beatOffsetSec) ||
      settings.beatOffsetSec < 0 ||
      settings.timeSignature.numerator < 1 ||
      settings.timeSignature.denominator < 1
    ) {
      throw new Error("メトロノーム設定が不正です");
    }
    this.#metronome = settings;
    this.#stopMetronomeClicks();
    this.#setMetronomeGain(
      settings.enabled && !this.#transportSilenced ? 1 : 0,
    );
    this.#resetMetronomeBeatIndex(this.currentTimelineTime());
    if (settings.enabled && this.#timer !== null) {
      this.#schedule();
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.#audioOutput.setOutputDevice(deviceId);
  }

  setTranscriptionDelayMs(delayMs: number): void {
    const delaySec = Number.isFinite(delayMs)
      ? Math.min(
          MAX_TRANSCRIPTION_DELAY_SEC,
          Math.max(0, delayMs / 1000),
        )
      : 0;
    this.#playbackDelay.delayTime.value = delaySec;
  }

  async destroy(): Promise<void> {
    this.pause();
    this.#synthBus.disconnect();
    this.#playbackDelay.disconnect();
    this.#synthGain.disconnect();
    this.#comparisonMonoBus.disconnect();
    this.#rightPanner.disconnect();
    this.#comparisonGain.disconnect();
    this.#metronomeGain.disconnect();
    this.#synth.destroy();
    this.#metronomeSynth.destroy();
    if (this.#ownsAudioOutput) {
      await this.#audioOutput.destroy();
    }
  }

  #applyTrackSettings(): void {
    for (const track of this.#trackById.values()) {
      const volume = trackMidiVolume(track);
      this.#synth.controllerChange(
        channelFor(track),
        volume.controller,
        volume.value,
      );
      if (track.kind === "pitched" && track.gmProgram !== null) {
        this.#synth.programChange(channelFor(track), track.gmProgram);
      }
    }
  }

  async #ensureRequiredSoundFontVoicesPreloaded(): Promise<void> {
    while (true) {
      if (this.#voicePreloadPromise !== null) {
        await this.#voicePreloadPromise;
        continue;
      }

      const requirements = [...this.#requiredSoundFontVoices.values()].filter(
        (requirement) =>
          !this.#preloadedSoundFontVoiceKeys.has(requirement.key),
      );
      if (requirements.length === 0) {
        return;
      }

      const preloadPromise = preloadSoundFontVoices(
        this.#voicePreloadSequencer,
        requirements,
      ).then(() => {
        for (const requirement of requirements) {
          this.#preloadedSoundFontVoiceKeys.add(requirement.key);
        }
        this.#applyTrackSettings();
      });
      this.#voicePreloadPromise = preloadPromise;
      try {
        await preloadPromise;
      } finally {
        if (this.#voicePreloadPromise === preloadPromise) {
          this.#voicePreloadPromise = null;
        }
      }
    }
  }

  #rampGain(node: GainNode, target: number): void {
    const now = this.#context.currentTime;
    const gain = node.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + GAIN_RAMP_SEC);
  }

  #rampGainAt(
    node: GainNode,
    target: number,
    contextTimeSec: number,
  ): void {
    const now = this.#context.currentTime;
    const startTime = Math.max(now, contextTimeSec);
    const gain = node.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.setValueAtTime(0, startTime);
    gain.linearRampToValueAtTime(target, startTime + GAIN_RAMP_SEC);
  }

  #synthGainTarget(source: "transcription" | "comparison"): number {
    if (this.#previewing) {
      return source === "transcription" ? 1 : 0;
    }
    return !this.#transportSilenced &&
      this.#timer !== null &&
      this.#transportRunning &&
      this.#source === source
      ? 1
      : 0;
  }

  #updateSynthRouting(): void {
    this.#rampGain(
      this.#synthGain,
      this.#synthGainTarget("transcription"),
    );
    this.#rampGain(
      this.#comparisonGain,
      this.#synthGainTarget("comparison"),
    );
  }

  #updateSynthRoutingAt(contextTimeSec: number): void {
    this.#rampGainAt(
      this.#synthGain,
      this.#synthGainTarget("transcription"),
      contextTimeSec,
    );
    this.#rampGainAt(
      this.#comparisonGain,
      this.#synthGainTarget("comparison"),
      contextTimeSec,
    );
  }

  #setMetronomeGain(target: number): void {
    const now = this.#context.currentTime;
    const gain = this.#metronomeGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(target, now);
  }

  #setMetronomeGainAt(target: number, contextTimeSec: number): void {
    const now = this.#context.currentTime;
    const startTime = Math.max(now, contextTimeSec);
    const gain = this.#metronomeGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(0, now);
    gain.setValueAtTime(target, startTime);
  }

  #silencePlaybackGains(): void {
    const now = this.#context.currentTime;
    const synthGain = this.#synthGain.gain;
    synthGain.cancelScheduledValues(now);
    synthGain.setValueAtTime(0, now);
    const comparisonGain = this.#comparisonGain.gain;
    comparisonGain.cancelScheduledValues(now);
    comparisonGain.setValueAtTime(0, now);
    this.#setMetronomeGain(0);
  }

  #finishPreview(): void {
    if (!this.#previewing) {
      return;
    }
    this.#previewing = false;
    this.#synth.stopAll(true);
    this.#updateSynthRouting();
    if (this.#timer !== null) {
      this.#resetNextNoteIndex(this.currentTimelineTime());
    }
  }

  currentTimelineTime(): number {
    if (this.#transportAnchor !== null && this.#timer !== null) {
      return timelineTimeAtContextTime(
        this.#transportAnchor,
        this.#context.currentTime,
      );
    }
    return sourceTimeToTimelineTime(
      this.#audio.currentTime,
      this.#timelineOffsetSec,
    );
  }

  #contextTimeForTimeline(
    timelineTimeSec: number,
    currentTimelineTimeSec: number,
    currentContextTimeSec: number,
  ): number {
    if (this.#transportAnchor === null) {
      return (
        currentContextTimeSec +
        Math.max(0, timelineTimeSec - currentTimelineTimeSec)
      );
    }
    return Math.max(
      currentContextTimeSec,
      contextTimeForTimelineTime(this.#transportAnchor, timelineTimeSec),
    );
  }

  #beatDurationSec(): number {
    return (
      (60 / this.#metronome.bpm) *
      (4 / this.#metronome.timeSignature.denominator)
    );
  }

  #resetMetronomeBeatIndex(timeSec: number): void {
    const relativeSec = timeSec - this.#metronome.beatOffsetSec;
    if (relativeSec <= SCHEDULE_EPSILON_SEC) {
      this.#nextMetronomeBeatIndex = 0;
      return;
    }
    this.#nextMetronomeBeatIndex = Math.max(
      0,
      Math.ceil(
        (relativeSec - SCHEDULE_EPSILON_SEC) / this.#beatDurationSec(),
      ),
    );
  }

  #stopMetronomeClicks(): void {
    const now = this.#context.currentTime;
    for (const click of this.#scheduledMetronomeClicks) {
      if (click.contextTime <= now + SCHEDULE_EPSILON_SEC) {
        continue;
      }
      this.#metronomeSynth.noteOff(
        METRONOME_MIDI_CHANNEL,
        click.pitch,
        { time: click.contextTime + SCHEDULE_CANCEL_DELAY_SEC },
      );
    }
    this.#scheduledMetronomeClicks = [];
    this.#metronomeSynth.stopAll(true);
  }

  #cancelScheduledNoteOns(): void {
    const now = this.#context.currentTime;
    for (const scheduled of this.#scheduledNoteOns.values()) {
      if (scheduled.contextTime <= now + SCHEDULE_EPSILON_SEC) {
        continue;
      }
      this.#synth.noteOff(scheduled.channel, scheduled.pitch, {
        time: scheduled.contextTime + SCHEDULE_CANCEL_DELAY_SEC,
      });
    }
    this.#scheduledNoteOns.clear();
  }

  #scheduleMetronome(
    masterTime: number,
    horizon: number,
    contextTime: number,
  ): void {
    if (!this.#metronome.enabled) {
      return;
    }
    this.#scheduledMetronomeClicks =
      this.#scheduledMetronomeClicks.filter(
        (click) => click.contextTime > contextTime + SCHEDULE_EPSILON_SEC,
      );
    const beatDurationSec = this.#beatDurationSec();
    while (true) {
      const beatTime =
        this.#metronome.beatOffsetSec +
        this.#nextMetronomeBeatIndex * beatDurationSec;
      if (beatTime > horizon + SCHEDULE_EPSILON_SEC) {
        return;
      }
      const beatIndex = this.#nextMetronomeBeatIndex;
      this.#nextMetronomeBeatIndex += 1;
      if (beatTime < masterTime - SCHEDULE_EPSILON_SEC) {
        continue;
      }

      const clickTime = this.#contextTimeForTimeline(
        beatTime,
        masterTime,
        contextTime,
      );
      const accented =
        beatIndex % this.#metronome.timeSignature.numerator === 0;
      const pitch = accented
        ? METRONOME_ACCENT_PITCH
        : METRONOME_REGULAR_PITCH;
      this.#metronomeSynth.noteOn(
        METRONOME_MIDI_CHANNEL,
        pitch,
        accented ? 118 : 92,
        { time: clickTime },
      );
      this.#metronomeSynth.noteOff(METRONOME_MIDI_CHANNEL, pitch, {
        time: clickTime + METRONOME_NOTE_LENGTH_SEC,
      });
      this.#scheduledMetronomeClicks.push({
        pitch,
        contextTime: clickTime,
      });
    }
  }

  #schedule(): void {
    if (!this.#transportRunning) {
      return;
    }
    const masterTime = this.currentTimelineTime();
    const horizon = masterTime + LOOKAHEAD_SEC;
    this.#scheduledThroughSec = Math.max(this.#scheduledThroughSec, horizon);
    const contextTime = this.#context.currentTime;
    for (const [id, scheduled] of this.#scheduledNoteOns) {
      if (scheduled.contextTime <= contextTime + SCHEDULE_EPSILON_SEC) {
        this.#scheduledNoteOns.delete(id);
      }
    }
    this.#scheduleMetronome(masterTime, horizon, contextTime);
    if (this.#previewing) {
      return;
    }
    if (this.#source === "original") {
      return;
    }
    while (this.#nextNoteEndIndex < this.#notesByEnd.length) {
      const note = this.#notesByEnd[this.#nextNoteEndIndex];
      if (note.endSec > horizon + SCHEDULE_EPSILON_SEC) {
        break;
      }
      this.#nextNoteEndIndex += 1;
      if (note.endSec < masterTime - SCHEDULE_EPSILON_SEC) {
        continue;
      }
      if (this.#suppressedNoteEndIds.delete(note.id)) {
        continue;
      }
      const track = this.#trackById.get(note.trackId);
      if (track === undefined) {
        continue;
      }
      const noteOffTime = this.#contextTimeForTimeline(
        note.endSec,
        masterTime,
        contextTime,
      );
      this.#synth.noteOff(channelFor(track), playbackPitch(track, note.pitch), {
        time: noteOffTime,
      });
      this.#pendingNoteEnds.delete(note.id);
    }
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
      const pitch = playbackPitch(track, note.pitch);
      const noteOnTime = this.#contextTimeForTimeline(
        note.startSec,
        masterTime,
        contextTime,
      );
      this.#synth.noteOn(channel, pitch, note.velocity, {
        time: noteOnTime,
      });
      this.#scheduledNoteOns.set(note.id, {
        channel,
        pitch,
        contextTime: noteOnTime,
      });
      this.#pendingNoteEnds.set(note.id, {
        channel,
        pitch,
        startContextTime: noteOnTime,
      });
    }
  }

}

export async function runSoundFontSmoke(
  audioUrl: string,
  silentOutput = false,
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
  const directContextOutput = supportsDirectAudioOutput();
  const engine = await SoundFontPlaybackEngine.create(audio, soundFontBytes, {
    silentOutput,
  });
  try {
    if (!silentOutput) {
      await engine.setOutputDevice("default");
    }
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
          playbackOctaveShift: 0,
          playbackVolume: 100,
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
