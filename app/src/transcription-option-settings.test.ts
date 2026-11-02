import { afterEach, describe, expect, it } from "vitest";
import type { SeparatedTranscriptionSettings } from "./types";
import {
  postTranscriptionOptionProcessing,
  postTranscriptionOptionStemTypes,
  readPostTranscriptionOptions,
  timingGuideReferenceAvailability,
  writePostTranscriptionOptions,
} from "./transcription-option-settings";

const defaults: SeparatedTranscriptionSettings = {
  drumOnsetGuide: true,
  timingGuideNoteFilter: false,
  velocityFromStemAmplitude: true,
};

afterEach(() => window.localStorage.clear());

describe("post-transcription option settings", () => {
  it("classifies saved-note and separated-audio postprocessing", () => {
    expect(postTranscriptionOptionProcessing("velocityFromStemAmplitude"))
      .toBe("stem_audio_postprocessing");
    expect(postTranscriptionOptionProcessing("timingGuideNoteFilter"))
      .toBe("saved_transcription_postprocessing");
  });

  it("limits each option to the affected separated inputs", () => {
    expect(postTranscriptionOptionStemTypes("timingGuideNoteFilter"))
      .toEqual(["bass", "piano", "guitar", "other"]);
    expect(postTranscriptionOptionStemTypes("velocityFromStemAmplitude"))
      .toEqual(["drums", "bass", "vocals", "piano", "guitar", "other"]);
  });

  it("reports only missing drumless timing references", () => {
    const primary = (inputName: "bass" | "piano") => ({
      inputName,
      role: "primary" as const,
      transcriptionPass: "drums_added_audio" as const,
      notes: [],
    });
    const reference = (inputName: "bass" | "piano") => ({
      inputName,
      role: "timing_reference" as const,
      transcriptionPass: "separated_audio" as const,
      notes: [],
    });

    expect(
      timingGuideReferenceAvailability([
        primary("bass"),
        primary("piano"),
        reference("piano"),
      ]),
    ).toEqual({
      hasApplicablePrimary: true,
      missingInputNames: ["bass"],
      available: false,
    });
    expect(
      timingGuideReferenceAvailability([
        primary("bass"),
        primary("piano"),
        reference("bass"),
        reference("piano"),
      ]).available,
    ).toBe(true);
    expect(timingGuideReferenceAvailability([])).toEqual({
      hasApplicablePrimary: false,
      missingInputNames: [],
      available: false,
    });
  });

  it("retains the two post-transcription selections", () => {
    writePostTranscriptionOptions({
      ...defaults,
      timingGuideNoteFilter: true,
    });

    expect(readPostTranscriptionOptions(defaults)).toMatchObject({
      timingGuideNoteFilter: true,
      velocityFromStemAmplitude: true,
    });
  });

  it("starts stem-amplitude velocity enabled when no selection is stored", () => {
    expect(readPostTranscriptionOptions(defaults).velocityFromStemAmplitude)
      .toBe(true);
  });

  it("ignores values outside the post-transcription selections", () => {
    writePostTranscriptionOptions({ ...defaults, drumOnsetGuide: false });

    expect(readPostTranscriptionOptions({ ...defaults, drumOnsetGuide: true }))
      .toMatchObject({
        drumOnsetGuide: true,
        timingGuideNoteFilter: false,
      });
  });
});
