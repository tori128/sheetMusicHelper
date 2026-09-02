import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  runSoundFontSmoke,
  type SoundFontSmokeResult,
} from "./soundfont-playback";
import { runPerformanceSmoke } from "./performance-smoke";
import { runMusicXmlPreviewSmoke } from "./musicxml-preview";
import "./styles.css";
import type { DesktopApi } from "./types";
import { LanguageProvider } from "./i18n";

const developmentWindow = window as unknown as { desktopApi?: DesktopApi };
if (new URLSearchParams(window.location.search).has("smoke")) {
  (
    window as unknown as {
      runSoundFontSmoke?: (
        audioUrl: string,
      ) => Promise<SoundFontSmokeResult>;
      runPerformanceSmoke?: typeof runPerformanceSmoke;
      runMusicXmlPreviewSmoke?: typeof runMusicXmlPreviewSmoke;
    }
  ).runSoundFontSmoke = runSoundFontSmoke;
  (
    window as unknown as {
      runPerformanceSmoke?: typeof runPerformanceSmoke;
    }
  ).runPerformanceSmoke = runPerformanceSmoke;
  (
    window as unknown as {
      runMusicXmlPreviewSmoke?: typeof runMusicXmlPreviewSmoke;
    }
  ).runMusicXmlPreviewSmoke = runMusicXmlPreviewSmoke;
}
if (import.meta.env.DEV && developmentWindow.desktopApi === undefined) {
  developmentWindow.desktopApi = {
    quitApplication: async () => undefined,
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
    writeSpectralAnalysisAudio: async () => "",
    deleteSpectralAnalysisAudio: async () => undefined,
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
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
);
