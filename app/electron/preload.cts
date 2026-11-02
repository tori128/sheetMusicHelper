import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ServiceConnection } from "./service-manager.js";
import type { UnsavedChangesState } from "./shutdown-controller.js";

contextBridge.exposeInMainWorld("desktopApi", {
  setUnsavedChanges: (state: UnsavedChangesState): void =>
    ipcRenderer.send("app:unsaved-changes", state),
  quitApplication: (): Promise<void> => ipcRenderer.invoke("app:quit"),
  getServiceConnection: (): Promise<ServiceConnection> =>
    ipcRenderer.invoke("service:get-connection"),
  getAboutInfo: () => ipcRenderer.invoke("app:get-about"),
  getLocalAudioUrl: (path: string): Promise<string> =>
    ipcRenderer.invoke("audio:get-local-url", path),
  loadSoundFont: (): Promise<Uint8Array> =>
    ipcRenderer.invoke("soundfont:load"),
  writeSpectralAnalysisAudio: (bytes: Uint8Array): Promise<string> =>
    ipcRenderer.invoke("analysis:write-audio", bytes),
  deleteSpectralAnalysisAudio: (path: string): Promise<void> =>
    ipcRenderer.invoke("analysis:delete-audio", path),
  selectAudioFile: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:select-audio"),
  getPathForDroppedFile: (file: File): string => webUtils.getPathForFile(file),
  selectModelFile: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:select-model"),
  selectProjectFile: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:select-project"),
  selectExportPath: (kind: "midi" | "musicxml"): Promise<string | null> =>
    ipcRenderer.invoke("dialog:select-export-path", kind),
  selectExportDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:select-export-directory"),
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke("shell:show-item-in-folder", path),
  saveProjectFile: (defaultName: string, json: string): Promise<string | null> =>
    ipcRenderer.invoke("dialog:save-project", defaultName, json),
});
