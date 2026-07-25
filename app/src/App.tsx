import { useEffect, useState } from "react";
import { LocalApiClient } from "./api";
import { EditorScreen } from "./components/EditorScreen";
import { NewProjectScreen } from "./components/NewProjectScreen";
import { projectStore } from "./store/project-store";
import { useProjectStore } from "./store/use-project-store";
import type {
  BackendCapability,
  InstrumentDefinition,
  ModelProfile,
  PresetDefinition,
} from "./types";

interface BootstrapData {
  client: LocalApiClient;
  instruments: InstrumentDefinition[];
  presets: PresetDefinition[];
  models: ModelProfile[];
  backends: BackendCapability[];
}

export default function App() {
  const state = useProjectStore();
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      try {
        const connection = await window.desktopApi.getServiceConnection();
        const client = new LocalApiClient(connection);
        const [instruments, presets, models, backends] = await Promise.all([
          client.instruments,
          client.presets,
          client.models,
          client.backends,
        ]);
        if (active) {
          setData({ client, instruments, presets, models, backends });
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
  }, []);

  if (error !== null) {
    return (
      <main className="bootstrap-message is-error">
        <strong>アプリを起動できません</strong>
        <span>{error}</span>
      </main>
    );
  }
  if (data === null) {
    return (
      <main className="bootstrap-message">
        <span className="loading-mark">E</span>
        <strong>EarCopy Assistを起動中…</strong>
      </main>
    );
  }
  if (state.screen === "editor" && state.project !== null) {
    return (
      <EditorScreen
        key={state.project.projectId}
        client={data.client}
        project={state.project}
        model={state.model}
        job={state.job}
        selectedNoteIds={state.selectedNoteIds}
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
      onModelsChange={(models) =>
        setData((current) => (current === null ? null : { ...current, models }))
      }
      onPresetsChange={(presets) =>
        setData((current) =>
          current === null ? null : { ...current, presets },
        )
      }
    />
  );
}
