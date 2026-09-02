import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Eraser,
  MoveRight,
  MousePointer2,
  Pencil,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import type { LocalApiClient } from "../api";
import { Localized, readAppLanguage, translateText } from "../i18n";
import {
  readAudioOutputDeviceId,
  writeAudioOutputDeviceId,
} from "../audio-output-settings";
import { PlaybackAudioOutput } from "../playback-audio-output";
import {
  hasMinimumAbRepeatDuration,
  repeatStartAtPosition,
  resolvePlaybackRepeatRange,
  type PlaybackRepeatMode,
  type PlaybackRepeatSettings,
} from "../playback-repeat";
import { PcmSourcePlayback } from "../pcm-source-playback";
import { PlaybackStartCoordinator } from "../playback-start";
import { formatPlaybackTime } from "../playback";
import {
  isPlaybackActive,
  requiresSourceMixer,
  resolvePlaybackRouting,
} from "../playback-routing";
import {
  readSourcePlaybackDelayMs,
  splitPlaybackSynchronizationDelayMs,
} from "../playback-sync-settings";
import {
  formatEstimatedRemainingTime,
  ProgressEtaEstimator,
} from "../progress-eta";
import {
  audibleTrackIds,
  normalizeMediaPlaybackRate,
  resolveTimelineSeek,
  sourceTimeToTimelineTime,
  SoundFontPlaybackEngine,
  type PlaybackSource,
} from "../soundfont-playback";
import { createSilentPlaybackUrl } from "../silent-playback-clock";
import {
  renderSpectralComparisonWav,
  selectSpectralComparison,
  spectralComparisonKey,
  SPECTRAL_DIFFERENCE_MAXIMUM_DURATION_SEC,
  type SpectralComparisonSelection,
  type SpectralDifferenceResult,
} from "../spectral-difference";
import {
  comparisonStems,
  comparisonTracks,
  playbackStemsForSource,
  playbackTracksForSource,
} from "../stem-playback";
import {
  isProjectEditingLocked,
  projectStore,
  type ProjectStoreState,
} from "../store/project-store";
import {
  gridDurationSeconds,
  quantizeNotes,
  snapTimeToGrid,
} from "../store/project-editing";
import {
  cancelProjectTranscription,
  startProjectTranscription,
} from "../services/transcription-controller";
import { TranscriptionOptionQueue } from "../services/transcription-option-queue";
import {
  postTranscriptionOptionsEqual,
  timingGuideReferenceAvailability,
  writePostTranscriptionOptions,
  type PostTranscriptionOptionKey,
} from "../transcription-option-settings";
import type {
  SeparatedTranscriptionSettings,
  ModelProfile,
  PlaybackAudioInfo,
  ProjectDocument,
  ProjectNote,
  QuantizeGrid,
  ScoreValidationIssue,
  ScoreValidationResult,
  StemType,
} from "../types";
import {
  PianoRollCanvas,
  type PianoRollTool,
} from "./PianoRollCanvas";
import { PlaybackSourceSwitch } from "./PlaybackSourceSwitch";
import { BpmInput } from "./BpmInput";
import {
  estimateChordSpansAsync,
  type EstimatedChordSpan,
} from "./chord-estimation";
import { EditorSidebar } from "./EditorSidebar";
import { ExportMenu } from "./ExportMenu";
import { ScoreExportDialog } from "./ScoreExportDialog";
import { SettingsDialog } from "./SettingsDialog";
import { PostTranscriptionOptions } from "./PostTranscriptionOptions";
import {
  visibleNotesForRoll,
} from "./piano-roll-visibility";

function applyPlaybackTimingCorrection(
  sourceMixer: PcmSourcePlayback | null,
  playbackEngine: SoundFontPlaybackEngine | null,
  enabled: boolean,
  signedDelayMs: number,
): void {
  const { sourceDelayMs, transcriptionDelayMs } =
    splitPlaybackSynchronizationDelayMs(enabled ? signedDelayMs : 0);
  sourceMixer?.setSourceDelayMs(sourceDelayMs);
  playbackEngine?.setTranscriptionDelayMs(transcriptionDelayMs);
}

interface EditorScreenProps {
  client: LocalApiClient;
  project: ProjectDocument;
  hasUnsavedChanges: boolean;
  model: ModelProfile | null;
  job: ProjectStoreState["job"];
  transcriptionMode: ProjectStoreState["transcriptionMode"];
  separatedSettings?: SeparatedTranscriptionSettings;
  selectedNoteIds: ReadonlySet<string>;
  canUndo: boolean;
  canRedo: boolean;
}

interface ChordAnalysisRequest {
  notes: readonly ProjectNote[];
  tracks: ProjectDocument["tracks"];
  bpm: number;
  beatOffsetSec: number;
  numerator: number;
  denominator: number;
}

interface ChordAnalysisState {
  request: ChordAnalysisRequest | null;
  status: "idle" | "running" | "completed" | "failed";
  progress: number;
  spans: EstimatedChordSpan[];
  error: string | null;
}

interface SpectralDifferenceState {
  status: "idle" | "running" | "completed" | "failed";
  key: string | null;
  label: string;
  result: SpectralDifferenceResult | null;
  error: string | null;
}

const JOB_LABELS: Record<
  NonNullable<ProjectStoreState["job"]>["status"],
  string
> = {
  waiting: "開始待ち",
  preparing_audio: "音源を準備中",
  separating: "音源を分離中",
  loading_model: "モデルを読み込み中",
  transcribing: "採譜中",
  building_project: "プロジェクトを構築中",
  completed: "採譜完了",
  failed: "採譜失敗",
  cancelled: "キャンセル済み",
};

const DISCARD_CHANGES_MESSAGE =
  "未保存の変更があります。保存せずに閉じますか？";
const EMPTY_CHORD_SPANS: EstimatedChordSpan[] = [];
const ORIGINAL_VOLUME_STORAGE_KEY = "earcopy-original-volume";

function initialOriginalVolume(): number {
  try {
    const storedValue = window.localStorage.getItem(ORIGINAL_VOLUME_STORAGE_KEY);
    if (storedValue === null) {
      return 100;
    }
    const stored = Number(storedValue);
    return Number.isFinite(stored) && stored >= 0 && stored <= 100
      ? stored
      : 100;
  } catch {
    return 100;
  }
}

export function EditorScreen({
  client,
  project,
  hasUnsavedChanges,
  model,
  job,
  transcriptionMode,
  separatedSettings = projectStore.getSnapshot().separatedSettings,
  selectedNoteIds,
  canUndo,
  canRedo,
}: EditorScreenProps) {
  const currentStoreState = useSyncExternalStore(
    projectStore.subscribe,
    projectStore.getSnapshot,
  );
  const playbackProject =
    currentStoreState.project?.projectId === project.projectId
      ? currentStoreState.project
      : project;
  const playbackSource = currentStoreState.playbackSource;
  const [transcriptionOptionQueue] = useState(
    () => new TranscriptionOptionQueue(client, projectStore),
  );
  const transcriptionOptionQueueState = useSyncExternalStore(
    transcriptionOptionQueue.subscribe,
    transcriptionOptionQueue.getSnapshot,
  );
  const audioRef = useRef<HTMLAudioElement>(null);
  const silentPlaybackUrlRef = useRef<string | null>(null);
  const playbackAudioInfoPromiseRef = useRef<Promise<PlaybackAudioInfo> | null>(
    null,
  );
  const sourceMixerRef = useRef<PcmSourcePlayback | null>(null);
  const sourceMixerPromiseRef = useRef<Promise<PcmSourcePlayback> | null>(
    null,
  );
  const sourceMixerGenerationRef = useRef(0);
  const playbackStartCoordinatorRef = useRef(
    new PlaybackStartCoordinator(),
  );
  const playbackConfigurationRequestRef = useRef(0);
  const playbackRepeatSettingsRef = useRef<PlaybackRepeatSettings>({
    mode: "off",
    aSec: null,
    bSec: null,
    fullStartSec: 0,
    fullEndSec: 0,
  });
  const playbackRepeatRestartPendingRef = useRef(false);
  const playbackIntendedToPlayRef = useRef(false);
  const playbackPositionHandlerRef = useRef<(timeSec: number) => void>(
    () => undefined,
  );
  const playbackEndedHandlerRef = useRef<() => void>(() => undefined);
  const playbackEngineRef = useRef<SoundFontPlaybackEngine | null>(null);
  const playbackEnginePromiseRef =
    useRef<Promise<SoundFontPlaybackEngine> | null>(null);
  const audioOutputRef = useRef<PlaybackAudioOutput | null>(null);
  const audioOutputPromiseRef = useRef<Promise<PlaybackAudioOutput> | null>(
    null,
  );
  const notePreviewRequestRef = useRef(0);
  const notePreviewReleaseRequestRef = useRef<number | null>(null);
  const seekInteractionRef = useRef({
    active: false,
    resumePlayback: false,
  });
  const progressEtaEstimatorRef = useRef(new ProgressEtaEstimator());
  const noteClipboardRef = useRef<ProjectNote[]>([]);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<
    "midi" | "musicxml" | "stems" | null
  >(null);
  const [exportedFile, setExportedFile] = useState<{
    kind: "MIDI" | "MusicXML" | "分離WAV";
    path: string;
  } | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [sourceAudioAvailability, setSourceAudioAvailability] = useState<
    "loading" | "available" | "unavailable"
  >("loading");
  const [playbackAudioInfo, setPlaybackAudioInfo] =
    useState<PlaybackAudioInfo | null>(null);
  const [playbackAudioPreparationError, setPlaybackAudioPreparationError] =
    useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playbackRepeatMode, setPlaybackRepeatMode] =
    useState<PlaybackRepeatMode>("off");
  const [repeatASec, setRepeatASec] = useState<number | null>(null);
  const [repeatBSec, setRepeatBSec] = useState<number | null>(null);
  const [clipboardNoteCount, setClipboardNoteCount] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [originalVolume, setOriginalVolume] = useState(initialOriginalVolume);
  const [sourcePlaybackDelayMs, setSourcePlaybackDelayMs] = useState(
    readSourcePlaybackDelayMs,
  );
  const [estimatedRemainingSeconds, setEstimatedRemainingSeconds] = useState<
    number | null
  >(null);
  const [soundFontBytes, setSoundFontBytes] = useState<Uint8Array | null>(null);
  const [outputDeviceId, setOutputDeviceId] = useState(
    readAudioOutputDeviceId,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [showScoreExport, setShowScoreExport] = useState(false);
  const [scoreValidation, setScoreValidation] =
    useState<ScoreValidationResult | null>(null);
  const [scorePreviewXml, setScorePreviewXml] = useState<string | null>(null);
  const [scorePanelLoading, setScorePanelLoading] = useState(false);
  const [showTranscriptionOptionsPane, setShowTranscriptionOptionsPane] =
    useState(true);
  const [editTargetTrackId, setEditTargetTrackId] = useState(
    project.tracks.find(({ kind }) => kind === "pitched")?.id ?? "",
  );
  const [pianoRollTool, setPianoRollTool] =
    useState<PianoRollTool>("select");
  const [quantizeGrid, setQuantizeGrid] = useState<QuantizeGrid>(
    project.tempo.quantizeGrid,
  );
  const [scoreQuantizeGrid, setScoreQuantizeGrid] = useState<QuantizeGrid>(
    project.tempo.quantizeGrid,
  );
  const [noteShiftMs, setNoteShiftMs] = useState(0);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [chordAnalysis, setChordAnalysis] = useState<ChordAnalysisState>({
    request: null,
    status: "idle",
    progress: 0,
    spans: [],
    error: null,
  });
  const [spectralDifference, setSpectralDifference] =
    useState<SpectralDifferenceState>({
      status: "idle",
      key: null,
      label: "",
      result: null,
      error: null,
  });
  const spectralComparison = useMemo<{
    selection: SpectralComparisonSelection | null;
    error: string | null;
  }>(() => {
    try {
      return {
        selection: selectSpectralComparison(project),
        error: null,
      };
    } catch (reason) {
      return {
        selection: null,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [project]);
  const currentSpectralDifferenceKey = useMemo(
    () =>
      spectralComparison.selection === null
        ? null
        : spectralComparisonKey(project, spectralComparison.selection),
    [project, spectralComparison.selection],
  );
  const groupedTracks = useMemo(
    () => comparisonTracks(playbackProject.tracks, playbackProject.stems),
    [playbackProject.stems, playbackProject.tracks],
  );
  const groupedStems = useMemo(
    () => comparisonStems(playbackProject.stems, playbackProject.tracks),
    [playbackProject.stems, playbackProject.tracks],
  );
  const stemSoloActive = playbackProject.stems.some((stem) => stem.solo);
  const sourceMixEnabled =
    playbackSource === "transcription" &&
    playbackProject.stems.some(
      (stem) => !stem.mute && (!stemSoloActive || stem.solo),
    );
  const transcriptionMixEnabled =
    playbackSource === "original" &&
    playbackProject.stems.length > 0 &&
    audibleTrackIds(playbackProject.tracks).size > 0;
  const playbackTracks = useMemo(() => {
    return playbackTracksForSource(
      playbackSource,
      playbackProject.tracks,
      groupedTracks,
      transcriptionMixEnabled,
    );
  }, [
    groupedTracks,
    playbackSource,
    playbackProject.tracks,
    transcriptionMixEnabled,
  ]);
  const playbackStems = useMemo(() => {
    return playbackStemsForSource(
      playbackSource,
      playbackProject.stems,
      groupedStems,
      sourceMixEnabled,
    );
  }, [
    groupedStems,
    playbackProject.stems,
    playbackSource,
    sourceMixEnabled,
  ]);
  const playbackRouting = resolvePlaybackRouting({
    source: playbackSource,
    sourceMixEnabled,
    transcriptionMixEnabled,
    metronomeEnabled,
  });
  const soundFontPlaybackSource = playbackRouting.soundFontSource;
  const sourceMixerPlaybackSource = playbackRouting.sourceMixerSource;
  const synchronizedSourcePlayback = playbackRouting.synchronized;
  const usesAudioContextPlaybackClock =
    playbackRouting.usesAudioContextClock;
  const visibleRollNotes = useMemo(
    () =>
      visibleNotesForRoll(
        playbackProject.notes,
        playbackProject.tracks,
        project.viewState.activeRoll,
      ),
    [
      playbackProject.notes,
      playbackProject.tracks,
      project.viewState.activeRoll,
    ],
  );
  const editTargetTrackOptions = useMemo(
    () =>
      project.tracks.filter(
        ({ kind }) =>
          kind ===
          (project.viewState.activeRoll === "drums" ? "drums" : "pitched"),
      ),
    [project.tracks, project.viewState.activeRoll],
  );
  const chordAnalysisRequest = useMemo<ChordAnalysisRequest>(
    () => ({
      notes: project.notes,
      tracks: project.tracks,
      bpm: project.tempo.bpm,
      beatOffsetSec: project.tempo.beatOffsetSec,
      numerator: project.tempo.timeSignature.numerator,
      denominator: project.tempo.timeSignature.denominator,
    }),
    [
      project.notes,
      project.tempo.beatOffsetSec,
      project.tempo.bpm,
      project.tempo.timeSignature.denominator,
      project.tempo.timeSignature.numerator,
      project.tracks,
    ],
  );
  const chordAnalysisAfterTranscription =
    job !== null &&
    (job.status === "completed" || job.status === "cancelled");
  const chordAnalysisEligible =
    job === null || chordAnalysisAfterTranscription;
  const editingLocked = isProjectEditingLocked(job);
  const chordAnalysisCurrent =
    chordAnalysis.request === chordAnalysisRequest;
  const spectralDifferenceCurrent =
    currentSpectralDifferenceKey !== null &&
    spectralDifference.key === currentSpectralDifferenceKey;
  const visibleSpectralDifference =
    spectralDifferenceCurrent && spectralDifference.status === "completed"
      ? spectralDifference.result
      : null;
  const appliedSeparatedSettings = useMemo<SeparatedTranscriptionSettings>(() => {
    const transcription = project.transcription;
    return {
      drumOnsetGuide:
        transcription?.drumOnsetGuide ?? separatedSettings.drumOnsetGuide,
      timingGuideNoteFilter:
        transcription?.timingGuideNoteFilter ??
        separatedSettings.timingGuideNoteFilter,
      velocityFromStemAmplitude:
        transcription?.velocityFromStemAmplitude ??
        separatedSettings.velocityFromStemAmplitude,
    };
  }, [separatedSettings, project.transcription]);
  const timingGuideReferences = useMemo(
    () =>
      timingGuideReferenceAvailability(
        project.transcription?.inputResults ?? [],
      ),
    [project.transcription?.inputResults],
  );
  useEffect(() => {
    setEditTargetTrackId((current) =>
      editTargetTrackOptions.some(({ id }) => id === current)
        ? current
        : (editTargetTrackOptions[0]?.id ?? ""),
    );
  }, [editTargetTrackOptions]);

  useEffect(() => {
    playbackRepeatRestartPendingRef.current = false;
    setPlaybackRepeatMode("off");
    setRepeatASec(null);
    setRepeatBSec(null);
  }, [project.projectId]);

  useEffect(() => {
    const normalizedVolume = originalVolume / 100;
    try {
      window.localStorage.setItem(
        ORIGINAL_VOLUME_STORAGE_KEY,
        String(originalVolume),
      );
    } catch {
      // Volume remains available for the current session when storage is blocked.
    }
    const mixer = sourceMixerRef.current;
    mixer?.setVolume(normalizedVolume);
    const audio = audioRef.current;
    if (audio !== null) {
      audio.volume =
        mixer === null
          ? playbackSource === "original"
            ? normalizedVolume
            : 0
          : 0;
    }
  }, [originalVolume, playbackSource, audioUrl]);
  const chordAnalysisRunning =
    chordAnalysisEligible &&
    (!chordAnalysisCurrent || chordAnalysis.status === "running");
  const chordAnalysisFailed =
    chordAnalysisCurrent && chordAnalysis.status === "failed";
  const chordSpans =
    chordAnalysisCurrent && chordAnalysis.status === "completed"
      ? chordAnalysis.spans
      : EMPTY_CHORD_SPANS;
  const timelineOffsetSec = project.sourceAudio.timelineOffsetSec;
  const timelineDurationSec = useMemo(
    () =>
      Math.max(
        0.01,
        project.sourceAudio.durationSec + timelineOffsetSec,
        project.notes.reduce(
          (latestEndSec, note) => Math.max(latestEndSec, note.endSec),
          0,
        ),
      ),
    [
      project.notes,
      project.sourceAudio.durationSec,
      timelineOffsetSec,
    ],
  );
  const playbackStartSec = sourceTimeToTimelineTime(0, timelineOffsetSec);
  const configuredAbRepeatRange = resolvePlaybackRepeatRange({
    mode: "ab",
    aSec: repeatASec,
    bSec: repeatBSec,
    fullStartSec: playbackStartSec,
    fullEndSec: timelineDurationSec,
  });
  playbackRepeatSettingsRef.current = {
    mode: playbackRepeatMode,
    aSec: repeatASec,
    bSec: repeatBSec,
    fullStartSec: playbackStartSec,
    fullEndSec: timelineDurationSec,
  };
  const spectralDifferenceUnavailableReason =
    spectralComparison.error ??
    (spectralComparison.selection?.notes.length === 0
      ? "比較する採譜ノートがありません"
      : soundFontBytes === null
        ? "採譜音源を読み込み中です"
        : timelineDurationSec > SPECTRAL_DIFFERENCE_MAXIMUM_DURATION_SEC
          ? `比較できる音源は${SPECTRAL_DIFFERENCE_MAXIMUM_DURATION_SEC / 60}分以下です`
          : null);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        projectStore.getSnapshot().hasUnsavedChanges &&
        !window.confirm(
          translateText(DISCARD_CHANGES_MESSAGE, readAppLanguage()),
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    void startProjectTranscription(client, projectStore);
  }, [client, project.projectId]);

  useEffect(() => {
    transcriptionOptionQueue.activate();
    return () => transcriptionOptionQueue.dispose();
  }, [transcriptionOptionQueue]);

  useEffect(() => {
    if (
      transcriptionOptionQueueState.status !== "failed" ||
      postTranscriptionOptionsEqual(
        separatedSettings,
        appliedSeparatedSettings,
      )
    ) {
      return;
    }
    projectStore.setSeparatedSettings(appliedSeparatedSettings);
    writePostTranscriptionOptions(appliedSeparatedSettings);
  }, [
    appliedSeparatedSettings,
    separatedSettings,
    transcriptionOptionQueueState.status,
  ]);

  function changePostTranscriptionOption(
    option: PostTranscriptionOptionKey,
    checked: boolean,
  ) {
    const settings = { ...separatedSettings, [option]: checked };
    projectStore.setSeparatedSettings(settings);
    writePostTranscriptionOptions(settings);
    transcriptionOptionQueue.enqueue(option, settings);
  }

  function cancelPostTranscriptionOptions() {
    transcriptionOptionQueue.cancel();
    projectStore.setSeparatedSettings(appliedSeparatedSettings);
    writePostTranscriptionOptions(appliedSeparatedSettings);
  }

  useEffect(() => {
    if (!chordAnalysisEligible) {
      setChordAnalysis((current) =>
        current.status === "idle" && current.request === null
          ? current
          : {
              request: null,
              status: "idle",
              progress: 0,
              spans: [],
              error: null,
            },
      );
      return;
    }

    const controller = new AbortController();
    setChordAnalysis({
      request: chordAnalysisRequest,
      status: "running",
      progress: 0,
      spans: [],
      error: null,
    });
    void estimateChordSpansAsync(
      chordAnalysisRequest.notes,
      chordAnalysisRequest.tracks,
      chordAnalysisRequest.bpm,
      chordAnalysisRequest.beatOffsetSec,
      chordAnalysisRequest.numerator,
      chordAnalysisRequest.denominator,
      {
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          const progress =
            total > 0
              ? Math.min(100, Math.round((completed / total) * 100))
              : 100;
          setChordAnalysis((current) =>
            current.request === chordAnalysisRequest &&
            current.progress !== progress
              ? { ...current, progress }
              : current,
          );
        },
      },
    )
      .then((spans) => {
        setChordAnalysis((current) =>
          current.request === chordAnalysisRequest
            ? {
                ...current,
                status: "completed",
                progress: 100,
                spans,
              }
            : current,
        );
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          return;
        }
        setChordAnalysis((current) =>
          current.request === chordAnalysisRequest
            ? {
                ...current,
                status: "failed",
                error: reason instanceof Error ? reason.message : String(reason),
              }
            : current,
        );
      });
    return () => controller.abort();
  }, [chordAnalysisEligible, chordAnalysisRequest]);

  useEffect(() => {
    if (chordAnalysis.status !== "completed") {
      return;
    }
    const currentProject = projectStore.getSnapshot().project;
    if (currentProject === null || currentProject.projectId !== project.projectId) {
      return;
    }
    projectStore.updateScoreSettings({
      chords: chordAnalysis.spans.map((span) => ({
        startSec: span.startSec,
        endSec: span.endSec,
        label: span.label,
      })),
    });
  }, [chordAnalysis.spans, chordAnalysis.status, project.projectId]);

  useEffect(() => {
    if (!showScoreExport) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void refreshScoreOutput();
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [showScoreExport, project.score, scoreQuantizeGrid]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (
        event.code === "Space" &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isFormInput
      ) {
        event.preventDefault();
        if (isPlaying) {
          pauseAudio();
        } else {
          void playAudio();
        }
        return;
      }
      if (isFormInput || target instanceof HTMLButtonElement) {
        return;
      }
      const commandKey = event.ctrlKey || event.metaKey;
      const editingIsLocked = isProjectEditingLocked(
        projectStore.getSnapshot().job,
      );
      if (commandKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        const copied = projectStore.copySelectedNotes();
        noteClipboardRef.current = copied;
        setClipboardNoteCount(copied.length);
        return;
      }
      if (commandKey && event.key.toLowerCase() === "x") {
        event.preventDefault();
        const copied = projectStore.copySelectedNotes();
        noteClipboardRef.current = copied;
        setClipboardNoteCount(copied.length);
        if (copied.length > 0) {
          stopNotePreview();
          projectStore.deleteSelectedNotes();
        }
        return;
      }
      if (commandKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        projectStore.pasteNotes(
          noteClipboardRef.current,
          snapTimeToGrid(
            playheadSec,
            project.tempo.bpm,
            quantizeGrid,
            project.tempo.beatOffsetSec,
          ),
        );
        return;
      }
      if (
        commandKey &&
        !event.altKey &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        projectStore.setSelection(visibleRollNotes.map((note) => note.id));
        return;
      }
      if (commandKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (editingIsLocked) {
          return;
        }
        if (event.shiftKey) {
          projectStore.redo();
        } else {
          projectStore.undo();
        }
        return;
      }
      if (commandKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (editingIsLocked) {
          return;
        }
        projectStore.redo();
        return;
      }
      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !commandKey &&
        !event.altKey &&
        project.viewState.activeRoll === "pitched" &&
        projectStore.getSnapshot().selectedNoteIds.size > 0
      ) {
        event.preventDefault();
        if (editingIsLocked) {
          return;
        }
        const pitchOffset =
          (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1);
        const before = projectStore.getSnapshot();
        const previewNote = before.project?.notes.find(({ id }) =>
          before.selectedNoteIds.has(id),
        );
        projectStore.moveSelectedNotesOnPianoRoll(0, pitchOffset);
        if (previewNote !== undefined) {
          const movedNote = projectStore
            .getSnapshot()
            .project?.notes.find(({ id }) => id === previewNote.id);
          if (movedNote !== undefined && movedNote.pitch !== previewNote.pitch) {
            void startNotePreview(movedNote);
            releaseNotePreview();
          }
        }
        return;
      }
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !commandKey &&
        !event.altKey &&
        projectStore.getSnapshot().selectedNoteIds.size > 0
      ) {
        event.preventDefault();
        if (editingIsLocked) {
          return;
        }
        const direction = event.key === "ArrowRight" ? 1 : -1;
        projectStore.moveSelectedNotesInTime(
          direction * gridDurationSeconds(project.tempo.bpm, quantizeGrid),
        );
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        projectStore.getSnapshot().selectedNoteIds.size > 0
      ) {
        event.preventDefault();
        stopNotePreview();
        projectStore.deleteSelectedNotes();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    let active = true;
    setIsPlaying(false);
    setPlayheadSec(0);
    setAudioUrl(null);
    setSourceAudioAvailability("loading");
    setPlaybackAudioInfo(null);
    setPlaybackAudioPreparationError(null);
    setPlaybackError(null);
    projectStore.selectPlaybackSource("original");
    void window.desktopApi
      .getLocalAudioUrl(project.sourceAudio.absolutePath)
      .then((url) => {
        if (active) {
          setAudioUrl(url);
          setSourceAudioAvailability("available");
        }
      })
      .catch(() => {
        if (active) {
          const silentUrl = createSilentPlaybackUrl(timelineDurationSec);
          silentPlaybackUrlRef.current = silentUrl;
          setAudioUrl(silentUrl);
          setSourceAudioAvailability("unavailable");
          playbackConfigurationRequestRef.current += 1;
          projectStore.selectPlaybackSource("transcription");
        }
      });
    const playbackAudioPreparation = client.preparePlaybackAudio(
      project.sourceAudio.absolutePath,
    );
    playbackAudioInfoPromiseRef.current = playbackAudioPreparation;
    void playbackAudioPreparation
      .then((information) => {
        if (active) {
          setPlaybackAudioInfo(information);
        }
      })
      .catch((reason) => {
        if (active) {
          setPlaybackAudioPreparationError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      active = false;
      playbackConfigurationRequestRef.current += 1;
      if (playbackAudioInfoPromiseRef.current === playbackAudioPreparation) {
        playbackAudioInfoPromiseRef.current = null;
      }
      if (silentPlaybackUrlRef.current !== null) {
        URL.revokeObjectURL(silentPlaybackUrlRef.current);
        silentPlaybackUrlRef.current = null;
      }
      audioRef.current?.pause();
      playbackStartCoordinatorRef.current.cancel();
      const mixer = sourceMixerRef.current;
      sourceMixerRef.current = null;
      sourceMixerPromiseRef.current = null;
      sourceMixerGenerationRef.current += 1;
      const engine = playbackEngineRef.current;
      playbackEngineRef.current = null;
      playbackEnginePromiseRef.current = null;
      const audioOutput = audioOutputRef.current;
      audioOutputRef.current = null;
      audioOutputPromiseRef.current = null;
      void (async () => {
        await Promise.all([mixer?.destroy(), engine?.destroy()]);
        await audioOutput?.destroy();
      })();
    };
  }, [project.projectId, project.sourceAudio.absolutePath]);

  useEffect(() => {
    let active = true;
    void window.desktopApi
      .loadSoundFont()
      .then((bytes) => {
        if (active) {
          setSoundFontBytes(bytes);
        }
      })
      .catch((reason) => {
        if (active) {
          setPlaybackError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [project.projectId]);

  useEffect(() => {
    const engine = playbackEngineRef.current;
    engine?.setProject(playbackTracks, playbackProject.notes);
    engine?.setSource(soundFontPlaybackSource);
  }, [playbackProject.notes, playbackTracks, soundFontPlaybackSource]);

  useEffect(() => {
    sourceMixerRef.current?.setMode(sourceMixerPlaybackSource);
    sourceMixerRef.current?.setStemStates(playbackStems);
    applyPlaybackTimingCorrection(
      sourceMixerRef.current,
      playbackEngineRef.current,
      synchronizedSourcePlayback,
      sourcePlaybackDelayMs,
    );
  }, [
    playbackStems,
    sourceMixerPlaybackSource,
    sourcePlaybackDelayMs,
    synchronizedSourcePlayback,
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    const engine = playbackEngineRef.current;
    engine?.setTimelineOffset(timelineOffsetSec);
    if (audio === null) {
      return;
    }
    const resolved = resolveTimelineSeek(
      sourceTimeToTimelineTime(audio.currentTime, timelineOffsetSec),
      timelineOffsetSec,
      project.sourceAudio.durationSec,
    );
    if (Math.abs(audio.currentTime - resolved.sourceTimeSec) > 1e-6) {
      audio.currentTime = resolved.sourceTimeSec;
      sourceMixerRef.current?.seek(resolved.sourceTimeSec);
      engine?.seek(resolved.timelineTimeSec);
    }
    setPlayheadSec(resolved.timelineTimeSec);
  }, [
    project.sourceAudio.durationSec,
    timelineOffsetSec,
  ]);

  useEffect(() => {
    playbackEngineRef.current?.setMetronome({
      enabled: metronomeEnabled,
      bpm: project.tempo.bpm,
      beatOffsetSec: project.tempo.beatOffsetSec,
      timeSignature: project.tempo.timeSignature,
    });
  }, [
    metronomeEnabled,
    project.tempo.beatOffsetSec,
    project.tempo.bpm,
    project.tempo.timeSignature,
  ]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    let frame = 0;
    const updateCursor = () => {
      const audio = audioRef.current;
      if (audio !== null) {
        const engine = playbackEngineRef.current;
        const sourceMixer = sourceMixerRef.current;
        const timelineTimeSec =
          usesAudioContextPlaybackClock && engine !== null
            ? engine.currentTimelineTime()
            : sourceMixer?.isPlaying
              ? sourceTimeToTimelineTime(
                  sourceMixer.currentSourceTime(),
                  timelineOffsetSec,
                )
              : sourceTimeToTimelineTime(audio.currentTime, timelineOffsetSec);
        playbackPositionHandlerRef.current(timelineTimeSec);
      }
      frame = requestAnimationFrame(updateCursor);
    };
    frame = requestAnimationFrame(updateCursor);
    return () => cancelAnimationFrame(frame);
  }, [
    isPlaying,
    timelineDurationSec,
    timelineOffsetSec,
    usesAudioContextPlaybackClock,
  ]);

  async function playAudio() {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    const repeatRange = resolvePlaybackRepeatRange(
      playbackRepeatSettingsRef.current,
    );
    if (
      !playbackRepeatRestartPendingRef.current &&
      repeatRange !== null &&
      (playheadSec < repeatRange.startSec || playheadSec >= repeatRange.endSec)
    ) {
      seekAudio(repeatRange.startSec);
    }
    playbackIntendedToPlayRef.current = true;
    setPlaybackError(null);
    try {
      normalizeMediaPlaybackRate(audio);
      const engine =
        playbackRouting.requiresSoundFont
          ? await ensurePlaybackEngine()
          : playbackEngineRef.current;
      const sourceMixer = requiresSourceMixer(
        playbackRouting,
        sourceMixerRef.current !== null,
        playbackStems.some((stem) => stem.mute || stem.solo),
      )
          ? await ensureSourceMixer()
          : null;
      const started = await playbackStartCoordinatorRef.current.start({
        audio,
        sourceMixer,
        engine,
        timelineOffsetSec,
      });
      if (started && sourceMixer !== null) {
        setIsPlaying(true);
      }
    } catch (reason) {
      playbackIntendedToPlayRef.current = false;
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function pauseAudio() {
    playbackIntendedToPlayRef.current = false;
    playbackStartCoordinatorRef.current.cancel();
    const audio = audioRef.current;
    const sourceMixer = sourceMixerRef.current;
    if (audio !== null && sourceMixer?.isPlaying) {
      audio.currentTime = sourceMixer.currentSourceTime();
    }
    audio?.pause();
    sourceMixer?.pause();
    playbackEngineRef.current?.pause();
    setIsPlaying(false);
  }

  async function ensureSourceMixer(): Promise<PcmSourcePlayback> {
    if (sourceMixerRef.current !== null) {
      return sourceMixerRef.current;
    }
    if (sourceMixerPromiseRef.current !== null) {
      return sourceMixerPromiseRef.current;
    }
    const preparedAudioInfo =
      playbackAudioInfo ?? (await playbackAudioInfoPromiseRef.current);
    if (preparedAudioInfo === null) {
      throw new Error(
        playbackAudioPreparationError ?? "同期再生用音声を準備しています",
      );
    }
    const generation = sourceMixerGenerationRef.current;
    const promise = (async () => {
      const audioOutput = await ensurePlaybackAudioOutput();
      const mixer = await PcmSourcePlayback.create(
        client,
        preparedAudioInfo,
        project.stems.map((stem) => ({
          type: stem.type,
          path: stem.cachePath,
        })),
        audioOutput,
      );
      try {
        if (generation !== sourceMixerGenerationRef.current) {
          throw new Error("再生対象が変更されました");
        }
        mixer.setMode(sourceMixerPlaybackSource);
        mixer.setVolume(originalVolume / 100);
        mixer.seek(audioRef.current?.currentTime ?? 0);
        if (audioRef.current !== null) {
          audioRef.current.volume = 0;
        }
        mixer.setEndedHandler(() => playbackEndedHandlerRef.current());
        mixer.setErrorHandler((message) => {
          playbackIntendedToPlayRef.current = false;
          audioRef.current?.pause();
          playbackEngineRef.current?.pause();
          setIsPlaying(false);
          setPlaybackError(message);
        });
        applyPlaybackTimingCorrection(
          mixer,
          playbackEngineRef.current,
          synchronizedSourcePlayback,
          sourcePlaybackDelayMs,
        );
        mixer.setStemStates(playbackStems);
        sourceMixerRef.current = mixer;
        if (generation !== sourceMixerGenerationRef.current) {
          sourceMixerRef.current = null;
          throw new Error("再生対象が変更されました");
        }
        return mixer;
      } catch (reason) {
        if (sourceMixerRef.current !== mixer) {
          await mixer.destroy();
        }
        throw reason;
      }
    })();
    sourceMixerPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (sourceMixerPromiseRef.current === promise) {
        sourceMixerPromiseRef.current = null;
      }
    }
  }

  async function ensurePlaybackAudioOutput(): Promise<PlaybackAudioOutput> {
    if (audioOutputRef.current !== null) {
      return audioOutputRef.current;
    }
    if (audioOutputPromiseRef.current !== null) {
      return audioOutputPromiseRef.current;
    }
    const audio = audioRef.current;
    if (audio === null) {
      throw new Error("原音を読み込み中です");
    }
    const generation = sourceMixerGenerationRef.current;
    const promise = (async () => {
      const audioOutput = await PlaybackAudioOutput.create(audio);
      if (generation !== sourceMixerGenerationRef.current) {
        await audioOutput.destroy();
        throw new Error("再生対象が変更されました");
      }
      try {
        await audioOutput.setOutputDevice(outputDeviceId);
      } catch (reason) {
        if (outputDeviceId === "default") {
          throw reason;
        }
        await audioOutput.setOutputDevice("default");
        setOutputDeviceId(writeAudioOutputDeviceId("default"));
      }
      if (generation !== sourceMixerGenerationRef.current) {
        await audioOutput.destroy();
        throw new Error("再生対象が変更されました");
      }
      audioOutputRef.current = audioOutput;
      return audioOutput;
    })();
    audioOutputPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (audioOutputPromiseRef.current === promise) {
        audioOutputPromiseRef.current = null;
      }
    }
  }

  async function ensurePlaybackEngine(): Promise<SoundFontPlaybackEngine> {
    if (playbackEngineRef.current !== null) {
      return playbackEngineRef.current;
    }
    if (playbackEnginePromiseRef.current !== null) {
      return playbackEnginePromiseRef.current;
    }
    if (audioRef.current === null || soundFontBytes === null) {
      throw new Error("SoundFontを読み込み中です");
    }
    const audio = audioRef.current;
    const bytes = soundFontBytes;
    const generation = sourceMixerGenerationRef.current;
    const promise = (async () => {
      const audioOutput = await ensurePlaybackAudioOutput();
      const engine = await SoundFontPlaybackEngine.create(
        audio,
        bytes,
        {},
        audioOutput,
      );
      try {
        if (generation !== sourceMixerGenerationRef.current) {
          throw new Error("再生対象が変更されました");
        }
        engine.setTimelineOffset(timelineOffsetSec);
        engine.setProject(playbackTracks, project.notes);
        engine.setSource(soundFontPlaybackSource);
        engine.setMetronome({
          enabled: metronomeEnabled,
          bpm: project.tempo.bpm,
          beatOffsetSec: project.tempo.beatOffsetSec,
          timeSignature: project.tempo.timeSignature,
        });
        applyPlaybackTimingCorrection(
          sourceMixerRef.current,
          engine,
          synchronizedSourcePlayback,
          sourcePlaybackDelayMs,
        );
        playbackEngineRef.current = engine;
        return engine;
      } catch (reason) {
        await engine.destroy();
        throw reason;
      }
    })();
    playbackEnginePromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      if (playbackEnginePromiseRef.current === promise) {
        playbackEnginePromiseRef.current = null;
      }
    }
  }

  async function startNotePreview(note: ProjectNote) {
    const requestId = ++notePreviewRequestRef.current;
    notePreviewReleaseRequestRef.current = null;
    const track = project.tracks.find(
      (candidate) => candidate.id === note.trackId,
    );
    if (track === undefined) {
      return;
    }
    setPlaybackError(null);
    try {
      const engine = await ensurePlaybackEngine();
      if (requestId !== notePreviewRequestRef.current) {
        return;
      }
      await engine.startNotePreview(track, note);
      if (requestId !== notePreviewRequestRef.current) {
        engine.stopNotePreview();
      } else if (notePreviewReleaseRequestRef.current === requestId) {
        engine.releaseNotePreview();
      }
    } catch (reason) {
      if (requestId === notePreviewRequestRef.current) {
        setPlaybackError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    }
  }

  function stopNotePreview() {
    notePreviewRequestRef.current += 1;
    notePreviewReleaseRequestRef.current = null;
    playbackEngineRef.current?.stopNotePreview();
  }

  function releaseNotePreview() {
    notePreviewReleaseRequestRef.current = notePreviewRequestRef.current;
    playbackEngineRef.current?.releaseNotePreview();
  }

  async function configurePlaybackControls(
    source: PlaybackSource,
    selectedProject: ProjectDocument,
    requestId: number,
  ) {
    const requestIsCurrent = () =>
      playbackConfigurationRequestRef.current === requestId;
    if (!requestIsCurrent()) {
      return;
    }
    const selectedGroupedTracks = comparisonTracks(
      selectedProject.tracks,
      selectedProject.stems,
    );
    const selectedGroupedStems = comparisonStems(
      selectedProject.stems,
      selectedProject.tracks,
    );
    const selectedStemSoloActive = selectedProject.stems.some(
      (stem) => stem.solo,
    );
    const selectedSourceMixEnabled =
      source === "transcription" &&
      selectedProject.stems.some(
        (stem) =>
          !stem.mute &&
          (!selectedStemSoloActive || stem.solo),
      );
    const selectedTranscriptionMixEnabled =
      source === "original" &&
      selectedProject.stems.length > 0 &&
      audibleTrackIds(selectedProject.tracks).size > 0;
    const targetTracks = playbackTracksForSource(
      source,
      selectedProject.tracks,
      selectedGroupedTracks,
      selectedTranscriptionMixEnabled,
    );
    const targetStems = playbackStemsForSource(
      source,
      selectedProject.stems,
      selectedGroupedStems,
      selectedSourceMixEnabled,
    );
    const targetRouting = resolvePlaybackRouting({
      source,
      sourceMixEnabled: selectedSourceMixEnabled,
      transcriptionMixEnabled: selectedTranscriptionMixEnabled,
      metronomeEnabled,
    });
    let engine = playbackEngineRef.current;
    let sourceMixer = sourceMixerRef.current;
    if (isPlaying) {
      engine = targetRouting.requiresSoundFont
        ? await ensurePlaybackEngine()
        : engine;
      if (!requestIsCurrent()) {
        return;
      }
      const sourceMixerRequired = requiresSourceMixer(
        targetRouting,
        sourceMixer !== null,
        targetStems.some((stem) => stem.mute || stem.solo),
      );
      sourceMixer = sourceMixerRequired ? await ensureSourceMixer() : null;
      if (!requestIsCurrent()) {
        return;
      }
    } else if (source !== "comparison") {
      sourceMixer?.pause();
    }
    if (!requestIsCurrent()) {
      return;
    }
    engine?.setProject(targetTracks, selectedProject.notes);
    engine?.setSource(targetRouting.soundFontSource);
    sourceMixer?.setStemStates(targetStems);
    sourceMixer?.setMode(targetRouting.sourceMixerSource);
    applyPlaybackTimingCorrection(
      sourceMixer ?? null,
      engine ?? null,
      targetRouting.synchronized,
      sourcePlaybackDelayMs,
    );
    if (audioRef.current !== null) {
      audioRef.current.volume =
        sourceMixer === null
          ? source === "original"
            ? originalVolume / 100
            : 0
          : 0;
    }
    if (isPlaying && audioRef.current !== null) {
      await playbackStartCoordinatorRef.current.start({
        audio: audioRef.current,
        sourceMixer,
        engine,
        timelineOffsetSec,
      });
    }
  }

  async function selectPlaybackSource(source: PlaybackSource) {
    if (
      source !== "transcription" &&
      sourceAudioAvailability === "unavailable"
    ) {
      return;
    }
    setPlaybackError(null);
    try {
      projectStore.selectPlaybackSource(source);
      const selectedProject =
        projectStore.getSnapshot().project ?? project;
      const requestId = playbackConfigurationRequestRef.current + 1;
      playbackConfigurationRequestRef.current = requestId;
      await configurePlaybackControls(source, selectedProject, requestId);
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function selectOutputDevice(deviceId: string) {
    setPlaybackError(null);
    try {
      await audioOutputRef.current?.setOutputDevice(deviceId);
      setOutputDeviceId(writeAudioOutputDeviceId(deviceId));
      if (
        isPlaying &&
        audioRef.current !== null &&
        audioOutputRef.current !== null
      ) {
        await playbackStartCoordinatorRef.current.start({
          audio: audioRef.current,
          sourceMixer: sourceMixerRef.current,
          engine: playbackEngineRef.current,
          timelineOffsetSec,
        });
      }
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function toggleMetronome(enabled: boolean) {
    setPlaybackError(null);
    try {
      const engine = enabled
        ? await ensurePlaybackEngine()
        : playbackEngineRef.current;
      engine?.setMetronome({
        enabled,
        bpm: project.tempo.bpm,
        beatOffsetSec: project.tempo.beatOffsetSec,
        timeSignature: project.tempo.timeSignature,
      });
      setMetronomeEnabled(enabled);
      if (
        enabled &&
        isPlaying &&
        audioRef.current !== null &&
        engine !== null
      ) {
        const mixer = await ensureSourceMixer();
        applyPlaybackTimingCorrection(
          mixer,
          engine,
          true,
          sourcePlaybackDelayMs,
        );
        await playbackStartCoordinatorRef.current.start({
          audio: audioRef.current,
          sourceMixer: mixer,
          engine,
          timelineOffsetSec,
        });
      }
    } catch (reason) {
      setMetronomeEnabled(false);
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function calculateSpectralDifference() {
    const selection = spectralComparison.selection;
    const requestKey = currentSpectralDifferenceKey;
    if (
      selection === null ||
      requestKey === null ||
      soundFontBytes === null
    ) {
      return;
    }
    let synthesizedPath: string | null = null;
    setSpectralDifference({
      status: "running",
      key: requestKey,
      label: selection.label,
      result: null,
      error: null,
    });
    try {
      const synthesizedAudio = await renderSpectralComparisonWav(
        soundFontBytes,
        selection.tracks,
        selection.notes,
        project.tempo.bpm,
        timelineDurationSec,
      );
      synthesizedPath = await window.desktopApi.writeSpectralAnalysisAudio(
        synthesizedAudio,
      );
      const result = await client.calculateSpectralDifference({
        sourcePaths: selection.sourcePaths,
        synthesizedPath,
        durationSec: timelineDurationSec,
        timelineOffsetSec,
        bpm: project.tempo.bpm,
        beatOffsetSec: project.tempo.beatOffsetSec,
        numerator: project.tempo.timeSignature.numerator,
        denominator: project.tempo.timeSignature.denominator,
      });
      setSpectralDifference({
        status: "completed",
        key: requestKey,
        label: selection.label,
        result,
        error: null,
      });
    } catch (reason) {
      setSpectralDifference({
        status: "failed",
        key: requestKey,
        label: selection.label,
        result: null,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (synthesizedPath !== null) {
        try {
          await window.desktopApi.deleteSpectralAnalysisAudio(
            synthesizedPath,
          );
        } catch {
          // Analysis files older than 24 hours are deleted before a later analysis.
        }
      }
    }
  }

  function scaleTempo(factor: 0.5 | 2) {
    const bpm =
      projectStore.getSnapshot().project?.tempo.bpm ?? project.tempo.bpm;
    projectStore.setBpm(bpm * factor);
  }

  function shiftNotesByMilliseconds(trackId: string | null) {
    const offsetSec = noteShiftMs / 1000;
    if (trackId === null) {
      projectStore.shiftAllNotes(offsetSec);
    } else {
      projectStore.shiftTrackNotes(trackId, offsetSec);
    }
    setNoteShiftMs(0);
  }

  function shiftNotesByBeats(beats: number, trackId: string | null) {
    const currentTempo =
      projectStore.getSnapshot().project?.tempo ?? project.tempo;
    const beatDurationSec =
      (60 / currentTempo.bpm) *
      (4 / currentTempo.timeSignature.denominator);
    const offsetSec = beatDurationSec * beats;
    if (trackId === null) {
      projectStore.shiftAllNotes(offsetSec);
    } else {
      projectStore.shiftTrackNotes(trackId, offsetSec);
    }
  }

  function stopAudio() {
    playbackIntendedToPlayRef.current = false;
    playbackStartCoordinatorRef.current.cancel();
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    audio.pause();
    sourceMixerRef.current?.pause();
    playbackEngineRef.current?.pause();
    const resolved = resolveTimelineSeek(
      0,
      timelineOffsetSec,
      project.sourceAudio.durationSec,
    );
    audio.currentTime = resolved.sourceTimeSec;
    sourceMixerRef.current?.seek(resolved.sourceTimeSec);
    playbackEngineRef.current?.seek(resolved.timelineTimeSec);
    setPlayheadSec(resolved.timelineTimeSec);
    setIsPlaying(false);
  }

  function seekAudio(timeSec: number) {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    const resolved = resolveTimelineSeek(
      timeSec,
      timelineOffsetSec,
      project.sourceAudio.durationSec,
    );
    audio.currentTime = resolved.sourceTimeSec;
    sourceMixerRef.current?.seek(resolved.sourceTimeSec);
    playbackEngineRef.current?.seek(resolved.timelineTimeSec);
    setPlayheadSec(resolved.timelineTimeSec);
  }

  function seekAudioPreservingPlaybackState(timeSec: number) {
    const audio = audioRef.current;
    const wasPlaying = isPlaybackActive(
      isPlaying,
      audio?.paused ?? true,
      sourceMixerRef.current?.isPlaying ?? false,
    );
    if (wasPlaying) {
      playbackStartCoordinatorRef.current.cancel();
    }
    seekAudio(timeSec);
    if (wasPlaying) {
      void playAudio();
    }
  }

  function restartPlaybackAtRepeatStart(timeSec: number) {
    if (playbackRepeatRestartPendingRef.current) {
      return;
    }
    playbackRepeatRestartPendingRef.current = true;
    playbackStartCoordinatorRef.current.cancel();
    seekAudio(timeSec);
    void playAudio().finally(() => {
      playbackRepeatRestartPendingRef.current = false;
    });
  }

  function updatePlaybackPosition(timeSec: number) {
    const boundedTimeSec = Math.min(timelineDurationSec, Math.max(0, timeSec));
    setPlayheadSec(boundedTimeSec);
    if (!playbackIntendedToPlayRef.current) {
      return;
    }
    const repeatStartSec = repeatStartAtPosition(
      boundedTimeSec,
      resolvePlaybackRepeatRange(playbackRepeatSettingsRef.current),
    );
    if (repeatStartSec !== null) {
      restartPlaybackAtRepeatStart(repeatStartSec);
    }
  }

  function handlePlaybackEnded() {
    const repeatRange = resolvePlaybackRepeatRange(
      playbackRepeatSettingsRef.current,
    );
    if (playbackIntendedToPlayRef.current && repeatRange !== null) {
      restartPlaybackAtRepeatStart(repeatRange.startSec);
      return;
    }
    playbackIntendedToPlayRef.current = false;
    playbackStartCoordinatorRef.current.cancel();
    audioRef.current?.pause();
    sourceMixerRef.current?.pause();
    playbackEngineRef.current?.pause();
    setIsPlaying(false);
    setPlayheadSec(timelineDurationSec);
  }

  function setFullRepeatEnabled() {
    const mode = playbackRepeatMode === "all" ? "off" : "all";
    playbackRepeatSettingsRef.current = {
      ...playbackRepeatSettingsRef.current,
      mode,
    };
    setPlaybackRepeatMode(mode);
  }

  function setRepeatPointA() {
    const aSec = Math.min(
      timelineDurationSec,
      Math.max(playbackStartSec, playheadSec),
    );
    const bSec =
      repeatBSec !== null &&
      hasMinimumAbRepeatDuration(aSec, repeatBSec)
        ? repeatBSec
        : null;
    const mode = playbackRepeatMode === "ab" && bSec === null
      ? "off"
      : playbackRepeatMode;
    playbackRepeatSettingsRef.current = {
      ...playbackRepeatSettingsRef.current,
      mode,
      aSec,
      bSec,
    };
    setRepeatASec(aSec);
    setRepeatBSec(bSec);
    setPlaybackRepeatMode(mode);
  }

  function setRepeatPointB() {
    if (
      repeatASec === null ||
      !hasMinimumAbRepeatDuration(repeatASec, playheadSec)
    ) {
      return;
    }
    const bSec = Math.min(timelineDurationSec, playheadSec);
    playbackRepeatSettingsRef.current = {
      ...playbackRepeatSettingsRef.current,
      bSec,
    };
    setRepeatBSec(bSec);
    if (playbackRepeatMode === "ab" && playheadSec >= bSec) {
      seekAudioPreservingPlaybackState(repeatASec);
    }
  }

  function setAbRepeatEnabled() {
    if (configuredAbRepeatRange === null) {
      return;
    }
    const mode = playbackRepeatMode === "ab" ? "off" : "ab";
    playbackRepeatSettingsRef.current = {
      ...playbackRepeatSettingsRef.current,
      mode,
    };
    setPlaybackRepeatMode(mode);
    if (
      mode === "ab" &&
      (playheadSec < configuredAbRepeatRange.startSec ||
        playheadSec >= configuredAbRepeatRange.endSec)
    ) {
      seekAudioPreservingPlaybackState(configuredAbRepeatRange.startSec);
    }
  }

  playbackPositionHandlerRef.current = updatePlaybackPosition;
  playbackEndedHandlerRef.current = handlePlaybackEnded;

  function beginSeekInteraction() {
    if (seekInteractionRef.current.active) {
      return;
    }
    const audio = audioRef.current;
    seekInteractionRef.current = {
      active: true,
      resumePlayback: isPlaybackActive(
        isPlaying,
        audio?.paused ?? true,
        sourceMixerRef.current?.isPlaying ?? false,
      ),
    };
    stopNotePreview();
    pauseAudio();
  }

  function endSeekInteraction() {
    const interaction = seekInteractionRef.current;
    if (!interaction.active) {
      return;
    }
    seekInteractionRef.current = {
      active: false,
      resumePlayback: false,
    };
    if (interaction.resumePlayback) {
      void playAudio();
    }
  }

  function applyPlaybackControlChange(update: () => void) {
    setPlaybackError(null);
    try {
      update();
      const selectedProject =
        projectStore.getSnapshot().project ?? project;
      const requestId = playbackConfigurationRequestRef.current + 1;
      playbackConfigurationRequestRef.current = requestId;
      void configurePlaybackControls(
        playbackSource,
        selectedProject,
        requestId,
      ).catch(
        (reason) => {
          setPlaybackError(
            reason instanceof Error ? reason.message : String(reason),
          );
        },
      );
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function toggleTrackMute(trackId: string) {
    applyPlaybackControlChange(() =>
      projectStore.togglePlaybackTrackMute(trackId),
    );
  }

  function toggleTrackSolo(trackId: string) {
    applyPlaybackControlChange(() =>
      projectStore.togglePlaybackTrackSolo(trackId),
    );
  }

  function toggleStemMute(stemType: StemType) {
    applyPlaybackControlChange(() =>
      projectStore.togglePlaybackStemMute(stemType),
    );
  }

  function toggleStemSolo(stemType: StemType) {
    applyPlaybackControlChange(() =>
      projectStore.togglePlaybackStemSolo(stemType),
    );
  }

  async function closeProject() {
    if (
      projectStore.getSnapshot().hasUnsavedChanges &&
      !window.confirm(
        translateText(DISCARD_CHANGES_MESSAGE, readAppLanguage()),
      )
    ) {
      return;
    }
    try {
      await cancelProjectTranscription(client, projectStore);
    } finally {
      projectStore.closeProject();
    }
  }

  function currentProject(): ProjectDocument {
    return projectStore.getSnapshot().project ?? project;
  }

  function scoreExportProject(): ProjectDocument {
    const latestProject = currentProject();
    return {
      ...latestProject,
      tempo: {
        ...latestProject.tempo,
        quantizeGrid: scoreQuantizeGrid,
      },
      notes: quantizeNotes(
        latestProject.notes,
        latestProject.tempo.bpm,
        scoreQuantizeGrid,
        latestProject.tempo.beatOffsetSec,
      ),
    };
  }

  async function refreshScoreOutput() {
    setScorePanelLoading(true);
    setSaveError(null);
    try {
      const latestProject = scoreExportProject();
      const [validation, xml] = await Promise.all([
        client.validateScore(latestProject),
        client.previewMusicXml(latestProject),
      ]);
      setScoreValidation(validation);
      setScorePreviewXml(xml);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScorePanelLoading(false);
    }
  }

  function openScoreExport() {
    setScoreQuantizeGrid(quantizeGrid);
    setShowScoreExport(true);
    setScoreValidation(null);
    setScorePreviewXml(null);
  }

  function changeScoreQuantizeGrid(grid: QuantizeGrid) {
    setScoreQuantizeGrid(grid);
    setScoreValidation(null);
    setScorePreviewXml(null);
  }

  function selectScoreIssue(issue: ScoreValidationIssue) {
    const track = issue.trackId === null
      ? null
      : project.tracks.find(({ id }) => id === issue.trackId) ?? null;
    if (track !== null) {
      projectStore.setActiveRoll(track.kind === "drums" ? "drums" : "pitched");
    }
    projectStore.setSelection(issue.noteIds);
    projectStore.setScrollTime(Math.max(0, issue.timeSec - 1));
    seekAudioPreservingPlaybackState(issue.timeSec);
    setShowScoreExport(false);
  }

  async function saveProject() {
    setSaving(true);
    setSaveError(null);
    try {
      const latestProject = currentProject();
      const path = await window.desktopApi.saveProjectFile(
        `${latestProject.name}.ecaproj`,
        JSON.stringify(latestProject, null, 2),
      );
      if (path !== null) {
        setSavedPath(path);
        projectStore.markSaved(latestProject);
      }
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function exportMidi() {
    const outputPath = await window.desktopApi.selectExportPath("midi");
    if (outputPath === null) {
      return;
    }
    setExporting("midi");
    setSaveError(null);
    try {
      const latestProject = currentProject();
      setExportedFile({
        kind: "MIDI",
        path: await client.exportMidi(latestProject, outputPath),
      });
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  }

  async function exportMusicXml() {
    const outputPath = await window.desktopApi.selectExportPath("musicxml");
    if (outputPath === null) {
      return;
    }
    setExporting("musicxml");
    setSaveError(null);
    try {
      const latestProject = scoreExportProject();
      setExportedFile({
        kind: "MusicXML",
        path: await client.exportMusicXml(latestProject, outputPath),
      });
      setShowScoreExport(false);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  }

  async function exportStemFiles() {
    const outputDirectory = await window.desktopApi.selectExportDirectory();
    if (outputDirectory === null) {
      return;
    }
    setExporting("stems");
    setSaveError(null);
    try {
      const paths = await client.exportStems(
        currentProject(),
        outputDirectory,
      );
      setExportedFile({ kind: "分離WAV", path: outputDirectory });
      if (paths.length > 0) {
        await window.desktopApi.showItemInFolder(paths[0]);
      }
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  }

  const optionProcessingRunning =
    transcriptionOptionQueueState.status === "running";
  const optionProcessingFailed =
    transcriptionOptionQueueState.status === "failed";
  const optionProcessingProgress =
    optionProcessingRunning && transcriptionOptionQueueState.total > 0
      ? Math.min(
          100,
          Math.round(
            (transcriptionOptionQueueState.completed /
              transcriptionOptionQueueState.total) *
              100,
          ),
        )
      : null;
  const transcriptionProgress =
    job !== null && job.total > 0
      ? Math.min(100, Math.round((job.completed / job.total) * 100))
      : null;
  const progress =
    optionProcessingRunning
      ? optionProcessingProgress
      : chordAnalysisAfterTranscription && chordAnalysisRunning
      ? chordAnalysisCurrent
        ? chordAnalysis.progress
        : 0
      : transcriptionProgress;
  const progressLabel =
    job?.status === "separating"
      ? "音源分離進捗"
      : optionProcessingRunning
      ? "採譜結果更新進捗"
      : chordAnalysisAfterTranscription && chordAnalysisRunning
      ? "コード解析進捗"
      : "採譜進捗";
  const estimatingChordProgress =
    chordAnalysisAfterTranscription && chordAnalysisRunning;
  const etaProgressKey = `${job?.id ?? project.projectId}:${
    job?.status === "separating"
      ? "separation"
      : optionProcessingRunning
      ? `option:${transcriptionOptionQueueState.runningOption ?? "starting"}`
      : estimatingChordProgress
        ? "chords"
        : "transcription"
  }`;
  const etaCompleted = optionProcessingRunning
    ? transcriptionOptionQueueState.completed
    : estimatingChordProgress
      ? chordAnalysisCurrent
        ? chordAnalysis.progress
        : 0
      : job?.completed ?? 0;
  const etaTotal = optionProcessingRunning
    ? transcriptionOptionQueueState.total
    : estimatingChordProgress
      ? 100
      : job?.total ?? 0;
  const etaStageRunning =
    job?.status === "separating" ||
    optionProcessingRunning ||
    estimatingChordProgress ||
    job?.status === "transcribing";
  const etaObservationReady =
    job?.status !== "separating" || etaTotal > 0;
  const etaActive =
    etaStageRunning && etaTotal > 0 && progress !== null && progress < 100;
  useEffect(() => {
    if (!etaStageRunning || !etaObservationReady) {
      progressEtaEstimatorRef.current.reset();
      setEstimatedRemainingSeconds(null);
      return;
    }
    progressEtaEstimatorRef.current.start(
      etaProgressKey,
      performance.now(),
    );
  }, [etaObservationReady, etaProgressKey, etaStageRunning]);
  useEffect(() => {
    if (!etaActive) {
      setEstimatedRemainingSeconds(null);
      return;
    }
    setEstimatedRemainingSeconds(
      progressEtaEstimatorRef.current.update({
        key: etaProgressKey,
        completed: etaCompleted,
        total: etaTotal,
        observedAtMs: performance.now(),
      }),
    );
  }, [etaActive, etaCompleted, etaProgressKey, etaTotal]);
  const estimatedRemainingLabel = etaActive
    ? estimatedRemainingSeconds === null
      ? "推定残り時間を計算中"
      : `推定残り時間: ${formatEstimatedRemainingTime(
          estimatedRemainingSeconds,
        )}`
    : null;
  const jobLabel =
    optionProcessingRunning
      ? `採譜結果更新: ${transcriptionOptionQueueState.detail ?? "開始中"}`
      : optionProcessingFailed
        ? "採譜オプション適用失敗"
        : job === null
      ? "採譜モデルなし"
      : chordAnalysisAfterTranscription && chordAnalysisRunning
        ? "コード解析中"
        : chordAnalysisAfterTranscription && chordAnalysisFailed
          ? "コード解析失敗"
          : job.detail ?? JOB_LABELS[job.status];
  const waitingForStemSeparation =
    transcriptionMode === "separated" && project.stems.length < 6;
  if (waitingForStemSeparation) {
    const active =
      job === null ||
      !["failed", "cancelled", "completed"].includes(job.status);
    const title =
      job?.status === "failed"
        ? "音源分離に失敗しました"
        : job?.status === "cancelled"
          ? "音源分離をキャンセルしました"
          : job?.status === "separating"
            ? "音源を分離中"
            : job !== null &&
                ["loading_model", "transcribing", "building_project"].includes(
                  job.status,
                )
              ? "分離した音源を準備中"
              : "音源分離を準備中";
    return (
      <Localized>
      <main className="stem-separation-screen">
        <header className="topbar">
          <button className="brand-button" onClick={() => void closeProject()}>
            <span className="brand-mark">E</span>
            <span>EarCopy Assist</span>
          </button>
          <div className="project-title">
            <strong data-localize="false">{project.name}</strong>
          </div>
        </header>
        <section className="stem-separation-progress" aria-live="polite">
          <h1>{title}</h1>
          {active && (
            <>
              {progress === null ? (
                <progress aria-label="音源分離進捗" />
              ) : (
                <progress
                  aria-label="音源分離進捗"
                  max="100"
                  value={progress}
                />
              )}
              {estimatedRemainingLabel !== null && (
                <span className="job-eta">{estimatedRemainingLabel}</span>
              )}
              <span>drums / bass / vocals / piano / guitar / other</span>
              <button
                className="secondary-button"
                onClick={() =>
                  void cancelProjectTranscription(client, projectStore)
                }
              >
                キャンセル
              </button>
            </>
          )}
          {!active && job?.error !== null && <p>{job?.error}</p>}
          {!active && (
            <button
              className="secondary-button"
              onClick={() => void closeProject()}
            >
              新規プロジェクトへ戻る
            </button>
          )}
        </section>
      </main>
      </Localized>
    );
  }

  return (
    <Localized>
    <main className="editor-screen">
      <header className="topbar">
        <button className="brand-button" onClick={() => void closeProject()}>
          <span className="brand-mark">E</span>
          <span>EarCopy Assist</span>
        </button>
        <div className="project-title">
          <strong data-localize="false">{project.name}</strong>
          <span>
            {hasUnsavedChanges
              ? "未保存の変更あり"
              : savedPath === null
                ? "保存済み"
                : `保存済み: ${savedPath}`}
          </span>
        </div>
        <div className="topbar-actions">
          <button
            className="secondary-button button-with-icon"
            disabled={saving}
            onClick={() => void saveProject()}
          >
            <Save size={15} aria-hidden="true" />
            {saving ? "保存中…" : "保存"}
          </button>
          <ExportMenu
            exporting={exporting}
            stemsAvailable={project.stems.length >= 4}
            onExportMidi={() => void exportMidi()}
            onExportMusicXml={openScoreExport}
            onExportStems={() => void exportStemFiles()}
          />
          <button
            className="secondary-button icon-button"
            aria-label="設定"
            title="設定"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="transport-bar" aria-label="再生コントロール">
        <audio
          key={project.projectId}
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="auto"
          onPlay={() => {
            playbackIntendedToPlayRef.current = true;
            setIsPlaying(true);
          }}
          onPause={(event) => {
            if (
              playbackRepeatRestartPendingRef.current ||
              (event.currentTarget.ended &&
                resolvePlaybackRepeatRange(
                  playbackRepeatSettingsRef.current,
                ) !== null)
            ) {
              return;
            }
            playbackIntendedToPlayRef.current = false;
            setIsPlaying(false);
            sourceMixerRef.current?.pause();
            playbackEngineRef.current?.pause();
          }}
          onEnded={() => {
            if (sourceMixerRef.current?.isPlaying) {
              return;
            }
            playbackEndedHandlerRef.current();
          }}
          onTimeUpdate={(event) => {
            const engine = playbackEngineRef.current;
            const timelineTimeSec =
              usesAudioContextPlaybackClock && engine !== null
                ? engine.currentTimelineTime()
                : sourceTimeToTimelineTime(
                    event.currentTarget.currentTime,
                    timelineOffsetSec,
                  );
            playbackPositionHandlerRef.current(timelineTimeSec);
          }}
          onError={() => setPlaybackError("音源を再生できません")}
        />
        <button
          className="transport-button"
          aria-label={isPlaying ? "一時停止" : "再生"}
          disabled={
            audioUrl === null ||
            (playbackSource !== "original" && soundFontBytes === null)
          }
          onClick={() => {
            if (isPlaying) {
              pauseAudio();
            } else {
              void playAudio();
            }
          }}
        >
          {isPlaying ? "Ⅱ" : "▶"}
        </button>
        <button
          className="transport-button"
          aria-label="停止"
          disabled={audioUrl === null}
          onClick={stopAudio}
        >
          ■
        </button>
        <span className="time-display">{formatPlaybackTime(playheadSec)}</span>
        <input
          className="transport-seek"
          aria-label="再生位置"
          type="range"
          min="0"
          max={timelineDurationSec}
          step="0.01"
          value={playheadSec}
          onPointerDown={beginSeekInteraction}
          onPointerUp={endSeekInteraction}
          onPointerCancel={endSeekInteraction}
          onKeyDown={(event) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(
                event.key,
              )
            ) {
              beginSeekInteraction();
            }
          }}
          onKeyUp={(event) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(
                event.key,
              )
            ) {
              endSeekInteraction();
            }
          }}
          onBlur={endSeekInteraction}
          onChange={(event) => seekAudio(Number(event.target.value))}
        />
        <div className="repeat-controls" role="group" aria-label="リピート">
          <span className="repeat-controls__label">リピート</span>
          <button
            type="button"
            className={`repeat-control-button${
              playbackRepeatMode === "all" ? " is-selected" : ""
            }`}
            aria-pressed={playbackRepeatMode === "all"}
            title="再生範囲の全体を繰り返す"
            onClick={setFullRepeatEnabled}
          >
            全体
          </button>
          <button
            type="button"
            className={`repeat-control-button repeat-point-button${
              repeatASec !== null ? " is-defined" : ""
            }`}
            aria-label="A点を現在位置に設定"
            title={`A点を現在位置に設定: ${formatPlaybackTime(playheadSec)}`}
            onClick={setRepeatPointA}
          >
            A
          </button>
          <button
            type="button"
            className={`repeat-control-button repeat-point-button${
              repeatBSec !== null ? " is-defined" : ""
            }`}
            aria-label="B点を現在位置に設定"
            title={`B点を現在位置に設定: ${formatPlaybackTime(playheadSec)}`}
            disabled={
              repeatASec === null ||
              !hasMinimumAbRepeatDuration(repeatASec, playheadSec)
            }
            onClick={setRepeatPointB}
          >
            B
          </button>
          <button
            type="button"
            className={`repeat-control-button${
              playbackRepeatMode === "ab" ? " is-selected" : ""
            }`}
            aria-pressed={playbackRepeatMode === "ab"}
            disabled={configuredAbRepeatRange === null}
            title="A点からB点までを繰り返す"
            onClick={setAbRepeatEnabled}
          >
            A-B
          </button>
          <output
            className="repeat-range-display"
            aria-label="A-Bリピート範囲"
          >
            A {repeatASec === null ? "--:--.---" : formatPlaybackTime(repeatASec)}
            {" / "}
            B {repeatBSec === null ? "--:--.---" : formatPlaybackTime(repeatBSec)}
          </output>
        </div>
        <PlaybackSourceSwitch
          value={playbackSource}
          sourceDisabled={sourceAudioAvailability === "unavailable"}
          transcriptionDisabled={soundFontBytes === null}
          onChange={(source) => void selectPlaybackSource(source)}
        />
        <label className="original-volume-control">
          <span>原音音量</span>
          <input
            aria-label="原音音量"
            type="range"
            min="0"
            max="100"
            step="1"
            value={originalVolume}
            onChange={(event) => setOriginalVolume(Number(event.target.value))}
          />
          <output>{originalVolume}%</output>
        </label>
        <label className="compact-field">
          BPM
          <BpmInput
            value={project.tempo.bpm}
            disabled={editingLocked}
            onCommit={(value) => projectStore.setBpm(value)}
          />
        </label>
        <span className="signature-display">
          {project.tempo.timeSignature.numerator}/
          {project.tempo.timeSignature.denominator}
        </span>
        <label className="metronome-control">
          <span>メトロノーム</span>
          <input
            type="checkbox"
            checked={metronomeEnabled}
            disabled={soundFontBytes === null}
            onChange={(event) =>
              void toggleMetronome(event.target.checked)
            }
          />
          <span className="toggle-track" aria-hidden="true">
            <span />
          </span>
        </label>
        <div className="job-status" aria-live="polite">
          <span
            title={
              optionProcessingFailed
                ? transcriptionOptionQueueState.error ?? undefined
                : chordAnalysisFailed
                  ? chordAnalysis.error ?? undefined
                  : jobLabel
            }
          >
            {jobLabel}
          </span>
          {optionProcessingRunning && progress === null ? (
            <progress aria-label={progressLabel} />
          ) : progress !== null ? (
            <progress aria-label={progressLabel} max="100" value={progress} />
          ) : null}
          {estimatedRemainingLabel !== null && (
            <span className="job-eta">{estimatedRemainingLabel}</span>
          )}
          {optionProcessingRunning ? (
            <button
              className="secondary-button"
              onClick={cancelPostTranscriptionOptions}
            >
              キャンセル
            </button>
          ) : (
            job !== null &&
            !["completed", "failed", "cancelled"].includes(job.status) && (
              <button
                className="secondary-button"
                onClick={() =>
                  void cancelProjectTranscription(client, projectStore)
                }
              >
                キャンセル
              </button>
            )
          )}
        </div>
      </section>

      <section
        className={
          showTranscriptionOptionsPane &&
          transcriptionMode === "separated" &&
          project.transcription !== null
            ? "workspace has-transcription-options"
            : "workspace"
        }
      >
        <EditorSidebar
          tracks={playbackProject.tracks}
          stems={playbackProject.stems}
          trackControlsDisabled={false}
          stemControlsDisabled={false}
          originalAudioMuted={playbackSource === "transcription"}
          noteCount={project.notes.length}
          selectedNoteCount={selectedNoteIds.size}
          bpm={project.tempo.bpm}
          beatOffsetSec={project.tempo.beatOffsetSec}
          quantizeGrid={quantizeGrid}
          noteShiftMs={noteShiftMs}
          editingLocked={editingLocked}
          canUndo={canUndo}
          canRedo={canRedo}
          onMute={toggleTrackMute}
          onSolo={toggleTrackSolo}
          onStemMute={toggleStemMute}
          onStemSolo={toggleStemSolo}
          onPlaybackOctaveShift={(id, shift) =>
            projectStore.setPlaybackOctaveShift(id, shift)
          }
          onPlaybackVolume={(id, volume) =>
            projectStore.setPlaybackVolume(id, volume)
          }
          onUndo={() => projectStore.undo()}
          onRedo={() => projectStore.redo()}
          onDeleteSelected={() => {
            stopNotePreview();
            projectStore.deleteSelectedNotes();
          }}
          canPaste={clipboardNoteCount > 0}
          onCopySelected={() => {
            const copied = projectStore.copySelectedNotes();
            noteClipboardRef.current = copied;
            setClipboardNoteCount(copied.length);
          }}
          onPaste={() =>
            projectStore.pasteNotes(
              noteClipboardRef.current,
              snapTimeToGrid(
                playheadSec,
                project.tempo.bpm,
                quantizeGrid,
                project.tempo.beatOffsetSec,
              ),
            )
          }
          onSplitSelected={() =>
            projectStore.splitSelectedNotes(
              snapTimeToGrid(
                playheadSec,
                project.tempo.bpm,
                quantizeGrid,
                project.tempo.beatOffsetSec,
              ),
            )
          }
          onJoinSelected={() =>
            projectStore.joinSelectedNotes(
              gridDurationSeconds(project.tempo.bpm, quantizeGrid),
            )
          }
          onSetSelectedDuration={() =>
            projectStore.setSelectedNoteDuration(
              gridDurationSeconds(project.tempo.bpm, quantizeGrid),
            )
          }
          onScaleTempo={scaleTempo}
          onSetMeasureStart={() =>
            projectStore.setSelectedNoteAsMeasureStart()
          }
          onQuantizeGridChange={setQuantizeGrid}
          onQuantize={() => projectStore.quantizeAll(quantizeGrid)}
          onNoteShiftMsChange={setNoteShiftMs}
          onShiftMilliseconds={shiftNotesByMilliseconds}
          onShiftBeats={shiftNotesByBeats}
        />
        <div className="roll-panel">
          <div className="roll-tabs">
            <button
              className={
                project.viewState.activeRoll === "pitched" ? "is-selected" : ""
              }
              onClick={() => projectStore.setActiveRoll("pitched")}
            >
              音程パート
            </button>
            <button
              className={
                project.viewState.activeRoll === "drums" ? "is-selected" : ""
              }
              onClick={() => projectStore.setActiveRoll("drums")}
            >
              ドラム
            </button>
            <div className="roll-tools">
              {transcriptionMode === "separated" &&
                project.transcription !== null && (
                  <button
                    type="button"
                    className={
                      showTranscriptionOptionsPane
                        ? "transcription-options-toggle is-selected"
                        : "transcription-options-toggle"
                    }
                    aria-pressed={showTranscriptionOptionsPane}
                    onClick={() =>
                      setShowTranscriptionOptionsPane((visible) => !visible)
                    }
                  >
                    <SlidersHorizontal size={14} aria-hidden="true" />
                    採譜オプション
                  </button>
                )}
              <div
                className="roll-tool-group spectral-difference-controls"
                role="group"
                aria-label="不一致度の表示"
              >
                <span className="roll-tool-group__label">不一致度の表示</span>
                <button
                  className="roll-tool-group__action"
                  aria-label="不一致度の表示を更新"
                  disabled={
                    spectralDifference.status === "running" ||
                    spectralDifferenceUnavailableReason !== null
                  }
                  title={
                    spectralDifferenceUnavailableReason ??
                    "拍ごとに原音と採譜音源の周波数成分を比較します"
                  }
                  onClick={() => void calculateSpectralDifference()}
                >
                  <RefreshCw
                    size={14}
                    aria-hidden="true"
                    className={
                      spectralDifference.status === "running"
                        ? "is-spinning"
                        : undefined
                    }
                  />
                  {spectralDifference.status === "running" ? "計算中" : "更新"}
                </button>
              </div>
              <div className="note-tool-selector" role="toolbar" aria-label="ノート編集ツール">
                {(
                  [
                    ["select", "選択"],
                    ["draw", "描画"],
                    ["erase", "消去"],
                  ] as const
                ).map(([tool, label]) => (
                  <button
                    key={tool}
                    className={pianoRollTool === tool ? "is-selected" : ""}
                    aria-label={`${label}ツール`}
                    aria-pressed={pianoRollTool === tool}
                    title={`${label}ツール`}
                    onClick={() => setPianoRollTool(tool)}
                  >
                    {tool === "select" ? (
                      <MousePointer2 size={15} aria-hidden="true" />
                    ) : tool === "draw" ? (
                      <Pencil size={15} aria-hidden="true" />
                    ) : (
                      <Eraser size={15} aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
              <div
                className="roll-tool-group note-track-move-controls"
                role="group"
                aria-label="ノートの移動"
              >
                <span className="roll-tool-group__label">ノートの移動</span>
                <select
                  aria-label="移動先トラック"
                  value={editTargetTrackId}
                  onChange={(event) => setEditTargetTrackId(event.target.value)}
                  disabled={editTargetTrackOptions.length === 0}
                >
                  {editTargetTrackOptions.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.displayName}
                    </option>
                  ))}
                </select>
                <button
                  className="roll-tool-group__action"
                  aria-label="選択ノートを指定トラックに移動"
                  disabled={selectedNoteIds.size === 0 || !editTargetTrackId}
                  onClick={() =>
                    projectStore.moveSelectedNotes(editTargetTrackId)
                  }
                >
                  <MoveRight size={14} aria-hidden="true" />
                  移動
                </button>
              </div>
            </div>
          </div>
          <div className="roll-surface">
            <PianoRollCanvas
              key={project.projectId}
              notes={visibleRollNotes}
              tracks={project.tracks}
              durationSec={timelineDurationSec}
              horizontalZoom={project.viewState.horizontalZoom}
              verticalZoom={project.viewState.verticalZoom}
              bpm={project.tempo.bpm}
              beatOffsetSec={project.tempo.beatOffsetSec}
              timeSignature={project.tempo.timeSignature}
              chordSpans={chordSpans}
              spectralDifferences={
                visibleSpectralDifference?.intervals ?? []
              }
              mode={project.viewState.activeRoll}
              selectedNoteIds={selectedNoteIds}
              initialScrollTimeSec={project.viewState.scrollTimeSec}
              playheadSec={playheadSec}
              followPlayhead={isPlaying}
              editingLocked={editingLocked}
              tool={pianoRollTool}
              quantizeGrid={quantizeGrid}
              editTargetTrackId={editTargetTrackId}
              onSelectionChange={(noteIds) =>
                projectStore.setSelection(noteIds)
              }
              onNotePreviewStart={(note) => void startNotePreview(note)}
              onNotePreviewEnd={(immediate) => {
                if (immediate) {
                  stopNotePreview();
                } else {
                  releaseNotePreview();
                }
              }}
              onMoveNotes={(offsetSec, pitchOffset) =>
                projectStore.moveSelectedNotesOnPianoRoll(
                  offsetSec,
                  pitchOffset,
                )
              }
              onResizeNoteStart={(noteId, startSec) =>
                projectStore.resizeNoteStart(noteId, startSec)
              }
              onResizeNote={(noteId, endSec) =>
                projectStore.resizeNoteEnd(noteId, endSec)
              }
              onCreateNote={(note) => projectStore.addNote(note)}
              onDeleteNotes={(noteIds) => {
                stopNotePreview();
                projectStore.deleteNotesByIds(noteIds);
              }}
              onSeek={(timeSec) => {
                stopNotePreview();
                seekAudioPreservingPlaybackState(timeSec);
              }}
              onScrollTimeChange={(timeSec) =>
                projectStore.setScrollTime(timeSec)
              }
              onZoomChange={(horizontalZoom, verticalZoom) =>
                projectStore.setZoom(horizontalZoom, verticalZoom)
              }
            />
            {project.notes.length === 0 && (
              <div className="empty-roll-message">
                <strong>
                  {model === null
                    ? "採譜モデルが選択されていません"
                    : job?.status === "completed"
                      ? "ノートは検出されませんでした"
                      : "採譜結果を待っています"}
                </strong>
                <span>
                  {model === null
                    ? "新規プロジェクト画面でローカルモデルを選択してください。"
                    : `${model.profileName} をローカルで実行しています。`}
                </span>
              </div>
            )}
            {(job?.error ?? saveError ?? playbackError) !== null && (
              <div className="roll-error">
                {job?.error ?? saveError ?? playbackError}
              </div>
            )}
          </div>
          <footer className="statusbar">
            <span>ノート {project.notes.length}</span>
            <span>選択 {selectedNoteIds.size}</span>
            <span>PPQ {project.tempo.ppq}</span>
            <span>音源 {project.sourceAudio.durationSec.toFixed(1)} 秒</span>
            {spectralDifference.status === "running" && (
              <span>原音との差を計算中</span>
            )}
            {visibleSpectralDifference !== null && (
              <span
                className="spectral-difference-legend"
                title="緑は曲中最小値、黄は曲中最小値と最大値の中央、赤は曲中最大値を示します"
              >
                原音との差 ({spectralDifference.label})
                <i aria-hidden="true" />
                {visibleSpectralDifference.minimum.toFixed(3)}–
                {visibleSpectralDifference.maximum.toFixed(3)}
              </span>
            )}
            {spectralDifferenceCurrent &&
              spectralDifference.status === "failed" && (
                <span className="spectral-difference-error">
                  不一致度の計算に失敗: {spectralDifference.error}
                </span>
              )}
            {exportedFile !== null && (
              <span>
                {exportedFile.kind}: {exportedFile.path}
              </span>
            )}
          </footer>
        </div>
        {showTranscriptionOptionsPane &&
          transcriptionMode === "separated" &&
          project.transcription !== null && (
            <aside
              className="transcription-options-pane"
              aria-label="採譜オプション"
            >
              <PostTranscriptionOptions
                settings={separatedSettings}
                appliedSettings={appliedSeparatedSettings}
                queue={transcriptionOptionQueueState}
                disabled={model === null}
                timingGuideReferences={timingGuideReferences}
                onChange={changePostTranscriptionOption}
                onCancel={cancelPostTranscriptionOptions}
                onClose={() => setShowTranscriptionOptionsPane(false)}
              />
            </aside>
          )}
      </section>
      {showSettings && (
        <SettingsDialog
          client={client}
          onAudioOutputDeviceChange={selectOutputDevice}
          onSourcePlaybackDelayChange={setSourcePlaybackDelayMs}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showScoreExport && (
        <ScoreExportDialog
          project={project}
          validation={scoreValidation}
          musicXml={scorePreviewXml}
          loading={scorePanelLoading}
          quantizeGrid={scoreQuantizeGrid}
          onChange={(update) => projectStore.updateScoreSettings(update)}
          onQuantizeGridChange={changeScoreQuantizeGrid}
          onRefresh={() => void refreshScoreOutput()}
          onSelectIssue={selectScoreIssue}
          onExport={() => void exportMusicXml()}
          onClose={() => setShowScoreExport(false)}
        />
      )}
    </main>
    </Localized>
  );
}
