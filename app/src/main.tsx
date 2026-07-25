import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  runSoundFontSmoke,
  type SoundFontSmokeResult,
} from "./soundfont-playback";
import { runPerformanceSmoke } from "./performance-smoke";
import "./styles.css";
import type { DesktopApi } from "./types";

const developmentWindow = window as unknown as { desktopApi?: DesktopApi };
if (new URLSearchParams(window.location.search).has("smoke")) {
  (
    window as unknown as {
      runSoundFontSmoke?: (
        audioUrl: string,
      ) => Promise<SoundFontSmokeResult>;
      runPerformanceSmoke?: typeof runPerformanceSmoke;
    }
  ).runSoundFontSmoke = runSoundFontSmoke;
  (
    window as unknown as {
      runPerformanceSmoke?: typeof runPerformanceSmoke;
    }
  ).runPerformanceSmoke = runPerformanceSmoke;
}
if (import.meta.env.DEV && developmentWindow.desktopApi === undefined) {
  developmentWindow.desktopApi = {
    getServiceConnection: async () => ({
      baseUrl: window.location.origin,
      token: "",
    }),
    getAboutInfo: async () => ({
      appVersion: "development",
      engineVersion: "0.2.2",
      notices: [],
    }),
    getLocalAudioUrl: async (path) => `file:///${path.replaceAll("\\", "/")}`,
    loadSoundFont: async () => new Uint8Array(),
    selectAudioFile: async () => null,
    getPathForDroppedFile: () => "",
    selectModelFile: async () => null,
    selectProjectFile: async () => null,
    selectExportPath: async () => null,
    selectExportDirectory: async () => null,
    showItemInFolder: async () => undefined,
    saveProjectFile: async () => null,
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
