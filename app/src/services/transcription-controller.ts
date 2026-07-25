import { LocalApiClient } from "../api";
import { ProjectStore } from "../store/project-store";

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
  store.beginJob("");
  try {
    const jobId = await client.startTranscription(
      project,
      model,
      initial.transcriptionMode,
      initial.inferenceBackend,
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
          store.applyJobEvent(event);
        }
      },
      controller.signal,
    );
  } catch (reason) {
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
