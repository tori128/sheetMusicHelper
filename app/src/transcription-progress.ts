import type {
  JobPartialResultEvent,
  JobTranscriptionProgressEvent,
  TranscriptionPass,
} from "./types";

const TRANSCRIPTION_INPUT_LABELS: Readonly<Record<string, string>> = {
  direct: "原音",
  "drums+bass+vocals": "ドラム・ベース・ボーカル",
  drums: "ドラム",
  bass: "ベース",
  vocals: "ボーカル",
  piano: "ピアノ成分",
  guitar: "ギター成分",
  other: "その他成分",
};

const TRANSCRIPTION_PASS_LABELS: Readonly<Record<TranscriptionPass, string>> = {
  original_audio: "原音",
  separated_audio: "分離音源",
  drums_added_audio: "ドラム成分追加後",
  other_added_audio: "Other成分追加後",
};

export function transcriptionInputLabel(inputName: string): string {
  return TRANSCRIPTION_INPUT_LABELS[inputName] ?? inputName;
}

export function transcriptionPassProgressDetail(
  event: JobTranscriptionProgressEvent,
): string {
  return `${transcriptionInputLabel(event.transcriptionInputName)}（${
    TRANSCRIPTION_PASS_LABELS[event.transcriptionPass]
  }、${event.inputPassIndex}/${event.inputPassCount}）を採譜中`;
}

export function transcriptionPassCompletion(
  event: JobPartialResultEvent,
  detail?: string,
): string {
  const progress = `${event.completedPasses}/${event.totalPasses}ステップ`;
  return `${transcriptionInputLabel(event.inputName)} 完了 (${[
    progress,
    detail,
  ]
    .filter((value) => value !== undefined)
    .join(", ")})`;
}
