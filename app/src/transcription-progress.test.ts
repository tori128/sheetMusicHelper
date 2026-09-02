import { describe, expect, it } from "vitest";
import {
  transcriptionPassCompletion,
  transcriptionPassProgressDetail,
} from "./transcription-progress";

describe("transcription progress labels", () => {
  it("identifies the audio variant and the pass within each part", () => {
    expect(
      transcriptionPassProgressDetail({
        type: "progress",
        stage: "transcribing",
        completed: 1,
        total: 8,
        transcriptionInputName: "vocals",
        transcriptionPass: "drums_added_audio",
        inputPassIndex: 1,
        inputPassCount: 1,
      }),
    ).toBe("ボーカル（ドラム成分追加後、1/1）を採譜中");
    expect(
      transcriptionPassProgressDetail({
        type: "progress",
        stage: "transcribing",
        completed: 2,
        total: 8,
        transcriptionInputName: "bass",
        transcriptionPass: "separated_audio",
        inputPassIndex: 2,
        inputPassCount: 2,
      }),
    ).toBe("ベース（分離音源、2/2）を採譜中");
  });

  it("reports completed transcription passes instead of only completed parts", () => {
    expect(
      transcriptionPassCompletion({
        type: "partial_result",
        inputName: "bass",
        completedInputs: 1,
        totalInputs: 6,
        completedPasses: 2,
        totalPasses: 8,
        noteCount: 12,
      }),
    ).toBe("ベース 完了 (2/8ステップ)");
  });
});
