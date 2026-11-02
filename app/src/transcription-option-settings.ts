import type {
  ProjectTranscriptionInputResult,
  SeparatedTranscriptionSettings,
  StemType,
} from "./types";

export const POST_TRANSCRIPTION_OPTION_KEYS = [
  "velocityFromStemAmplitude",
  "timingGuideNoteFilter",
] as const;

export type PostTranscriptionOptionKey =
  (typeof POST_TRANSCRIPTION_OPTION_KEYS)[number];

export type PostTranscriptionOptionProcessing =
  | "stem_audio_postprocessing"
  | "saved_transcription_postprocessing";

const POST_TRANSCRIPTION_OPTION_PROCESSING: Readonly<
  Record<PostTranscriptionOptionKey, PostTranscriptionOptionProcessing>
> = {
  velocityFromStemAmplitude: "stem_audio_postprocessing",
  timingGuideNoteFilter: "saved_transcription_postprocessing",
};

export function postTranscriptionOptionProcessing(
  option: PostTranscriptionOptionKey,
): PostTranscriptionOptionProcessing {
  return POST_TRANSCRIPTION_OPTION_PROCESSING[option];
}

const POST_TRANSCRIPTION_OPTION_STEM_TYPES: Readonly<
  Record<PostTranscriptionOptionKey, readonly StemType[]>
> = {
  timingGuideNoteFilter: ["bass", "piano", "guitar", "other"],
  velocityFromStemAmplitude: [
    "drums",
    "bass",
    "vocals",
    "piano",
    "guitar",
    "other",
  ],
};

export function postTranscriptionOptionStemTypes(
  option: PostTranscriptionOptionKey,
): readonly StemType[] {
  return POST_TRANSCRIPTION_OPTION_STEM_TYPES[option];
}

export interface TimingGuideReferenceAvailability {
  hasApplicablePrimary: boolean;
  missingInputNames: readonly StemType[];
  available: boolean;
}

export function timingGuideReferenceAvailability(
  inputResults: readonly ProjectTranscriptionInputResult[],
): TimingGuideReferenceAvailability {
  const supportedInputNames = POST_TRANSCRIPTION_OPTION_STEM_TYPES
    .timingGuideNoteFilter;
  const primaryInputNames = new Set(
    inputResults
      .filter(
        (result) =>
          result.role === "primary" &&
          result.transcriptionPass === "drums_added_audio" &&
          supportedInputNames.includes(result.inputName as StemType),
      )
      .map((result) => result.inputName),
  );
  const referenceInputNames = new Set(
    inputResults
      .filter((result) => result.role === "timing_reference")
      .map((result) => result.inputName),
  );
  const missingInputNames = supportedInputNames.filter(
    (inputName) =>
      primaryInputNames.has(inputName) && !referenceInputNames.has(inputName),
  );
  const hasApplicablePrimary = primaryInputNames.size > 0;
  return {
    hasApplicablePrimary,
    missingInputNames,
    available: hasApplicablePrimary && missingInputNames.length === 0,
  };
}

const STORAGE_KEY = "earcopy-post-transcription-options";

export function readPostTranscriptionOptions(
  defaults: SeparatedTranscriptionSettings,
): SeparatedTranscriptionSettings {
  const result = { ...defaults };
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) {
      return result;
    }
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    for (const key of POST_TRANSCRIPTION_OPTION_KEYS) {
      if (typeof parsed[key] === "boolean") {
        result[key] = parsed[key];
      }
    }
    return result;
  } catch {
    return result;
  }
}

export function writePostTranscriptionOptions(
  settings: SeparatedTranscriptionSettings,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(
          POST_TRANSCRIPTION_OPTION_KEYS.map((key) => [key, settings[key]]),
        ),
      ),
    );
  } catch {
    // The selection remains available in the current project.
  }
}

export function postTranscriptionOptionsEqual(
  left: SeparatedTranscriptionSettings,
  right: SeparatedTranscriptionSettings,
): boolean {
  return POST_TRANSCRIPTION_OPTION_KEYS.every((key) => left[key] === right[key]);
}
