import { useEffect, useState } from "react";
import { LocalApiClient } from "./api";
import { EditorScreen } from "./components/EditorScreen";
import { NewProjectScreen } from "./components/NewProjectScreen";
import { StartupTermsDialog } from "./components/StartupTermsDialog";
import { projectStore } from "./store/project-store";
import { useProjectStore } from "./store/use-project-store";
import { Localized } from "./i18n";
import type {
  BackendCapability,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
  StemSeparationCapability,
} from "./types";

interface BootstrapData {
  client: LocalApiClient;
  instruments: InstrumentDefinition[];
  presets: PresetDefinition[];
  models: ModelProfile[];
  backends: BackendCapability[];
  stemSeparation: StemSeparationCapability;
}

export default function App() {
  const state = useProjectStore();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!termsAccepted) {
      return;
    }
    let active = true;
    async function bootstrap() {
      try {
        const connection = await window.desktopApi.getServiceConnection();
        const client = new LocalApiClient(connection);
        const [instruments, presets, models, backends, stemSeparation] =
          await Promise.all([
            client.instruments,
            client.presets,
            client.models,
            client.backends,
            client.stemSeparation,
          ]);
        if (active) {
          setData({
            client,
            instruments,
            presets,
            models,
            backends,
            stemSeparation,
          });
          if (
            import.meta.env.DEV &&
            new URLSearchParams(window.location.search).has("editor-demo") &&
            projectStore.getSnapshot().screen === "new-project" &&
            presets[0] !== undefined
          ) {
            projectStore.createProject({
              name: "Visual QA",
              audio: {
                absolutePath: "D:\\music\\visual-qa.wav",
                sha256: "0".repeat(64),
                durationSec: 180,
                sampleRate: 44100,
                channels: 2,
                codecName: "pcm_s16le",
              },
              bpm: 120,
              numerator: 4,
              denominator: 4,
              preset: presets[0],
              instruments,
              model: null,
            });
          }
        }
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [termsAccepted]);

  if (!termsAccepted) {
    return (
      <StartupTermsDialog
        onAccept={() => setTermsAccepted(true)}
        onExit={() => void window.desktopApi.quitApplication()}
      />
    );
  }

  if (error !== null) {
    return (
      <Localized>
      <main className="bootstrap-message is-error">
        <strong>アプリを起動できません</strong>
        <span>{error}</span>
      </main>
      </Localized>
    );
  }
  if (data === null) {
    return (
      <Localized>
      <main className="bootstrap-message">
        <span className="loading-mark">E</span>
        <strong>EarCopy Assistを起動中…</strong>
      </main>
      </Localized>
    );
  }
  if (state.screen === "editor" && state.project !== null) {
    return (
      <EditorScreen
        key={state.project.projectId}
        client={data.client}
        project={state.project}
        hasUnsavedChanges={state.hasUnsavedChanges}
        model={state.model}
        job={state.job}
        transcriptionMode={state.transcriptionMode}
        separatedSettings={state.separatedSettings}
        selectedNoteIds={state.selectedNoteIds}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
      />
    );
  }
  return (
    <NewProjectScreen
      client={data.client}
      instruments={data.instruments}
      presets={data.presets}
      models={data.models}
      backends={data.backends}
      stemSeparation={data.stemSeparation}
      initialSourceSelection={state.recentSourceSelection}
      onModelsChange={(models) =>
        setData((current) => (current === null ? null : { ...current, models }))
      }
      onStemSeparationChange={(stemSeparation) =>
        setData((current) =>
          current === null ? null : { ...current, stemSeparation },
        )
      }
      onPresetsChange={(presets) =>
        setData((current) =>
          current === null ? null : { ...current, presets },
        )
      }
    />
  );
}
