import { useSyncExternalStore } from "react";
import { projectStore, type ProjectStoreState } from "./project-store";

export function useProjectStore(): ProjectStoreState {
  return useSyncExternalStore(projectStore.subscribe, projectStore.getSnapshot);
}

