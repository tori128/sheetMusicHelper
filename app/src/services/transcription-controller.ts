import { LocalApiClient } from "../api";
import { ProjectStore } from "../store/project-store";
import type {
  JobNoteEvent,
  JobTrackEvent,
  JobTranscriptionInputResultEvent,
} from "../types";

const controllers = new Map<string, AbortController>();

export async function startProjectTranscription(
  client: LocalApiClient,
  store: ProjectStore,
): Promise<void> {
  const initial = store.getSnapshot();
  const project = initial.project;
  const model = initial.model;
  if (project === null || model === null || initial.job !== null) {
    return;
  }
  const projectId = project.projectId;
  const deferNoteMerge = initial.transcriptionMode === "separated";
  const pendingNotes: JobNoteEvent[] = [];
  const pendingTracks: JobTrackEvent[] = [];
  const pendingInputResults: JobTranscriptionInputResultEvent[] = [];
  const flushPendingNotes = () => {
    if (
      pendingTracks.length === 0 &&
      pendingInputResults.length === 0 &&
      pendingNotes.length === 0
    ) {
      return;
    }
    const tracks = pendingTracks.splice(0);
    const inputResults = pendingInputResults.splice(0);
    const notes = pendingNotes.splice(0);
    if (store.getSnapshot().project?.projectId === projectId) {
      tracks.forEach((track) => store.applyJobEvent(track));
      inputResults.forEach((result) => store.applyJobEvent(result));
      store.applyJobNoteEvents(notes);
    }
  };
  store.beginJob("");
  try {
    const jobId = await client.startTranscription(
      project,
      model,
      initial.transcriptionMode,
      initial.inferenceBackend,
      initial.separatedSettings,
      initial.instrumentSelectionMode,
      initial.transcriptionProfile,
    );
    if (store.getSnapshot().project?.projectId !== projectId) {
      await client.cancelTranscription(jobId);
      return;
    }
    store.beginJob(jobId);
    const controller = new AbortController();
    controllers.set(projectId, controller);
    await client.streamJobEvents(
      jobId,
      (event) => {
        if (store.getSnapshot().project?.projectId === projectId) {
          if (event.type === "note") {
            pendingNotes.push(event);
          } else if (event.type === "track" && deferNoteMerge) {
            pendingTracks.push(event);
          } else if (
            event.type === "transcription_input_result" &&
            deferNoteMerge
          ) {
            pendingInputResults.push(event);
          } else {
            const mergeCompletedSeparatedResult =
              event.type === "state" && event.status === "completed";
            const mergePartialSeparatedResult = event.type === "partial_result";
            if (
              !deferNoteMerge ||
              mergeCompletedSeparatedResult ||
              mergePartialSeparatedResult
            ) {
              flushPendingNotes();
            } else if (
              event.type === "state" &&
              (event.status === "failed" || event.status === "cancelled")
            ) {
              pendingNotes.length = 0;
              pendingTracks.length = 0;
              pendingInputResults.length = 0;
            }
            store.applyJobEvent(event);
          }
        }
      },
      controller.signal,
    );
    if (deferNoteMerge) {
      pendingNotes.length = 0;
      pendingTracks.length = 0;
      pendingInputResults.length = 0;
    } else {
      flushPendingNotes();
    }
  } catch (reason) {
    if (deferNoteMerge) {
      pendingNotes.length = 0;
      pendingTracks.length = 0;
      pendingInputResults.length = 0;
    } else {
      flushPendingNotes();
    }
    if (reason instanceof DOMException && reason.name === "AbortError") {
      return;
    }
    if (store.getSnapshot().project?.projectId === projectId) {
      store.failJob(reason instanceof Error ? reason.message : String(reason));
    }
  } finally {
    controllers.delete(projectId);
  }
}

export async function cancelProjectTranscription(
  client: LocalApiClient,
  store: ProjectStore,
): Promise<void> {
  const state = store.getSnapshot();
  const projectId = state.project?.projectId;
  if (projectId === undefined || state.job === null) {
    return;
  }
  controllers.get(projectId)?.abort();
  if (state.job.id) {
    await client.cancelTranscription(state.job.id);
  }
  if (store.getSnapshot().project?.projectId === projectId) {
    store.applyJobEvent({ type: "state", status: "cancelled" });
  }
}
