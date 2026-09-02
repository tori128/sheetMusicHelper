import type { LocalApiClient } from "../api";
import type { ProjectStore } from "../store/project-store";
import type {
  ProjectTranscriptionInputResult,
  SeparatedTranscriptionSettings,
  StemType,
  TranscriptionJobEvent,
  TranscriptionJobStatus,
} from "../types";
import {
  postTranscriptionOptionProcessing,
  postTranscriptionOptionsEqual,
  timingGuideReferenceAvailability,
  type PostTranscriptionOptionKey,
} from "../transcription-option-settings";

interface QueueItem {
  option: PostTranscriptionOptionKey;
  settings: SeparatedTranscriptionSettings;
}

export interface TranscriptionOptionQueueState {
  status: "idle" | "running" | "failed";
  runningOption: PostTranscriptionOptionKey | null;
  pendingOptions: readonly PostTranscriptionOptionKey[];
  jobStatus: TranscriptionJobStatus | null;
  completed: number;
  total: number;
  detail: string | null;
  error: string | null;
}

const INITIAL_STATE: TranscriptionOptionQueueState = {
  status: "idle",
  runningOption: null,
  pendingOptions: [],
  jobStatus: null,
  completed: 0,
  total: 0,
  detail: null,
  error: null,
};

export class TranscriptionOptionQueue {
  #state: TranscriptionOptionQueueState = INITIAL_STATE;
  #listeners = new Set<() => void>();
  #pending: QueueItem[] = [];
  #running = false;
  #disposed = false;
  #abortController: AbortController | null = null;
  #runningJobId: string | null = null;

  constructor(
    private readonly client: LocalApiClient,
    private readonly store: ProjectStore,
  ) {}

  getSnapshot = (): TranscriptionOptionQueueState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  activate(): void {
    this.#disposed = false;
  }

  enqueue(
    option: PostTranscriptionOptionKey,
    settings: SeparatedTranscriptionSettings,
  ): void {
    if (this.#disposed) {
      return;
    }
    const last = this.#pending.at(-1);
    if (
      last !== undefined &&
      postTranscriptionOptionsEqual(last.settings, settings)
    ) {
      return;
    }
    this.#pending.push({ option, settings: { ...settings } });
    this.#publish({
      ...this.#state,
      pendingOptions: this.#pending.map((item) => item.option),
      error: null,
    });
    void this.#drain();
  }

  cancel(): void {
    this.#pending = [];
    this.#abortController?.abort();
    this.#cancelRunningJob();
    this.#publish({
      ...INITIAL_STATE,
      detail: "採譜オプションの適用をキャンセルしました",
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = [];
    this.#abortController?.abort();
    this.#cancelRunningJob();
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#disposed) {
      return;
    }
    this.#running = true;
    try {
      while (!this.#disposed && this.#pending.length > 0) {
        const item = this.#pending.shift();
        if (item === undefined) {
          break;
        }
        const snapshot = this.store.getSnapshot();
        const project = snapshot.project;
        if (
          project === null ||
          project.transcription === null ||
          snapshot.transcriptionMode !== "separated"
        ) {
          throw new Error("音源分離後の採譜結果が必要です");
        }
        const projectId = project.projectId;
        const processing = postTranscriptionOptionProcessing(item.option);
        this.#publish({
          status: "running",
          runningOption: item.option,
          pendingOptions: this.#pending.map((pending) => pending.option),
          jobStatus: null,
          completed: 0,
          total: 0,
          detail:
            processing === "stem_audio_postprocessing"
              ? "ベロシティを更新しています"
              : "保存済みの採譜入力別ノートを処理しています",
          error: null,
        });

        const controller = new AbortController();
        this.#abortController = controller;
        if (processing === "stem_audio_postprocessing") {
          const notes = await this.client.applyStemAmplitudeVelocitySetting(
            this.store.getTranscriptionAnalysisNotes(),
            project.stems,
            item.settings.velocityFromStemAmplitude,
            controller.signal,
          );
          this.#abortController = null;
          if (this.store.getSnapshot().project?.projectId !== projectId) {
            return;
          }
          this.store.applyStemAmplitudeVelocityResult(
            notes,
            item.settings.velocityFromStemAmplitude,
          );
          continue;
        }

        let inputResults = project.transcription.inputResults;
        if (item.option === "timingGuideNoteFilter" && item.settings[item.option]) {
          const availability = timingGuideReferenceAvailability(inputResults);
          if (!availability.hasApplicablePrimary) {
            throw new Error("保存済みのdrums追加後採譜結果がありません");
          }
          if (availability.missingInputNames.length > 0) {
            inputResults = await this.#collectTimingReferences(
              availability.missingInputNames,
              item.settings,
              controller.signal,
            );
          }
        }

        let notes = await this.client.applySavedTranscriptionOptions(
          inputResults,
          project.tracks,
          project.transcription.instrumentSelectionMode,
          item.settings,
          controller.signal,
        );
        if (item.settings.velocityFromStemAmplitude && notes.length > 0) {
          notes = await this.client.applyStemAmplitudeVelocitySetting(
            notes,
            project.stems,
            true,
            controller.signal,
          );
        }
        this.#abortController = null;
        if (this.store.getSnapshot().project?.projectId !== projectId) {
          return;
        }
        this.store.applySavedTranscriptionOptionResult(
          notes,
          item.settings,
          item.option,
          inputResults,
        );
      }
      if (!this.#disposed) {
        this.#publish({
          ...INITIAL_STATE,
          detail: "採譜オプションを適用しました",
        });
      }
    } catch (reason) {
      this.#abortController = null;
      if (reason instanceof DOMException && reason.name === "AbortError") {
        if (!this.#disposed) {
          this.#publish({
            ...INITIAL_STATE,
            detail: "採譜オプションの適用をキャンセルしました",
          });
        }
      } else if (!this.#disposed) {
        this.#pending = [];
        this.#publish({
          ...INITIAL_STATE,
          status: "failed",
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    } finally {
      this.#running = false;
      if (!this.#disposed && this.#pending.length > 0) {
        void this.#drain();
      }
    }
  }

  #publish(state: TranscriptionOptionQueueState): void {
    if (this.#disposed) {
      return;
    }
    this.#state = state;
    this.#listeners.forEach((listener) => listener());
  }

  async #collectTimingReferences(
    inputNames: readonly StemType[],
    settings: SeparatedTranscriptionSettings,
    signal: AbortSignal,
  ): Promise<ProjectTranscriptionInputResult[]> {
    const snapshot = this.store.getSnapshot();
    const project = snapshot.project;
    const model = snapshot.model;
    if (project === null || project.transcription === null || model === null) {
      throw new Error("drums無加算採譜に必要なプロジェクト情報がありません");
    }

    this.#publish({
      ...this.#state,
      jobStatus: "waiting",
      completed: 0,
      total: inputNames.length,
      detail: `drums無加算を採譜しています: ${inputNames.join(", ")}`,
      error: null,
    });
    const jobId = await this.client.startTranscription(
      project,
      model,
      "separated",
      snapshot.inferenceBackend,
      settings,
      project.transcription.instrumentSelectionMode,
      project.transcription.transcriptionProfile,
      inputNames,
      "timing_reference_only",
    );
    this.#runningJobId = jobId;
    const references: ProjectTranscriptionInputResult[] = [];
    let failure: string | null = null;
    const onEvent = (event: TranscriptionJobEvent) => {
      if (
        event.type === "transcription_input_result" &&
        event.role === "timing_reference"
      ) {
        const { type: _type, ...reference } = event;
        references.push(reference);
        return;
      }
      if (event.type === "progress") {
        this.#publish({
          ...this.#state,
          jobStatus: event.stage,
          completed: event.completed,
          total: event.total,
          detail:
            event.stage === "transcribing"
              ? `drums無加算を採譜しています: ${event.transcriptionInputName}`
              : "分離音源を確認しています",
        });
        return;
      }
      if (event.type === "error") {
        failure = event.message;
        return;
      }
      if (
        event.type === "state" &&
        (event.status === "failed" || event.status === "cancelled")
      ) {
        failure ??= `drums無加算採譜が${event.status}になりました`;
      }
    };
    try {
      await this.client.streamJobEvents(jobId, onEvent, signal);
    } finally {
      this.#runningJobId = null;
    }
    if (failure !== null) {
      throw new Error(failure);
    }
    const referenceByInputName = new Map(
      references.map((reference) => [reference.inputName, reference]),
    );
    const missing = inputNames.filter(
      (inputName) => !referenceByInputName.has(inputName),
    );
    if (missing.length > 0) {
      throw new Error(
        `drums無加算採譜結果を取得できませんでした: ${missing.join(", ")}`,
      );
    }
    const referenceInputNames = new Set(inputNames);
    return [
      ...project.transcription.inputResults.filter(
        (result) =>
          result.role !== "timing_reference" ||
          !referenceInputNames.has(result.inputName as StemType),
      ),
      ...inputNames.map((inputName) => referenceByInputName.get(inputName)!),
    ];
  }

  #cancelRunningJob(): void {
    const jobId = this.#runningJobId;
    this.#runningJobId = null;
    if (jobId !== null) {
      void this.client.cancelTranscription(jobId).catch(() => undefined);
    }
  }
}
