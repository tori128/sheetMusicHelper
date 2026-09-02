import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeparatedTranscriptionSettings } from "../types";
import { PostTranscriptionOptions } from "./PostTranscriptionOptions";

const settings: SeparatedTranscriptionSettings = {
  drumOnsetGuide: true,
  timingGuideNoteFilter: false,
  velocityFromStemAmplitude: true,
};

const completeTimingGuideReferences = {
  hasApplicablePrimary: true,
  missingInputNames: [],
  available: true,
};

afterEach(cleanup);

describe("PostTranscriptionOptions", () => {
  it("reports running and waiting options", () => {
    const onChange = vi.fn();
    const onCancel = vi.fn();
    render(
      <PostTranscriptionOptions
        settings={{ ...settings, timingGuideNoteFilter: true }}
        appliedSettings={settings}
        queue={{
          status: "running",
          runningOption: "timingGuideNoteFilter",
          pendingOptions: ["velocityFromStemAmplitude"],
          jobStatus: "transcribing",
          completed: 3,
          total: 10,
          detail: "保存済みの採譜入力別ノートを処理しています",
          error: null,
        }}
        disabled={false}
        timingGuideReferences={completeTimingGuideReferences}
        onChange={onChange}
        onCancel={onCancel}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("適用中")).toBeInTheDocument();
    expect(screen.getByText("待機")).toBeInTheDocument();
    expect(
      screen.getByText("保存済みの採譜入力別ノートを処理しています"),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveValue(30);

    const progressRegion = screen
      .getByText("保存済みの採譜入力別ノートを処理しています")
      .closest<HTMLElement>(".post-transcription-options__progress");
    expect(progressRegion).not.toBeNull();
    fireEvent.click(
      within(progressRegion!).getByRole("button", { name: "キャンセル" }),
    );
    expect(onCancel).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText(/分離後音源の音量からベロシティを設定する/),
    ).toBeChecked();
    expect(screen.getByText("変更した順に適用します")).toBeVisible();
  });

  it("reports velocity calculation as application instead of analysis", () => {
    render(
      <PostTranscriptionOptions
        settings={{ ...settings, velocityFromStemAmplitude: false }}
        appliedSettings={settings}
        queue={{
          status: "running",
          runningOption: "velocityFromStemAmplitude",
          pendingOptions: [],
          jobStatus: null,
          completed: 0,
          total: 0,
          detail: "ベロシティを更新しています",
          error: null,
        }}
        disabled={false}
        timingGuideReferences={completeTimingGuideReferences}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("適用中")).toBeVisible();
    expect(screen.queryByText("解析中")).toBeNull();
    expect(screen.getByText("ベロシティを更新しています")).toBeVisible();
  });

  it("disables the timing comparison when drum timing reduction is disabled", () => {
    render(
      <PostTranscriptionOptions
        settings={{ ...settings, drumOnsetGuide: false }}
        appliedSettings={{ ...settings, drumOnsetGuide: false }}
        queue={{
          status: "idle",
          runningOption: null,
          pendingOptions: [],
          jobStatus: null,
          completed: 0,
          total: 0,
          detail: null,
          error: null,
        }}
        disabled={false}
        timingGuideReferences={completeTimingGuideReferences}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText(/ドラム成分の追加による音高の誤検出を削減する/),
    ).toBeDisabled();
    const disabledOption = screen
      .getByLabelText(/ドラム成分の追加による音高の誤検出を削減する/)
      .closest("label");
    expect(disabledOption).not.toBeNull();
    expect(within(disabledOption!).getByText("無効")).toBeVisible();
  });

  it("allows collection of missing drumless timing references", () => {
    render(
      <PostTranscriptionOptions
        settings={settings}
        appliedSettings={settings}
        queue={{
          status: "idle",
          runningOption: null,
          pendingOptions: [],
          jobStatus: null,
          completed: 0,
          total: 0,
          detail: null,
          error: null,
        }}
        disabled={false}
        timingGuideReferences={{
          hasApplicablePrimary: true,
          missingInputNames: ["bass"],
          available: false,
        }}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const option = screen.getByLabelText(
      /ドラム成分の追加による音高の誤検出を削減する/,
    );
    expect(option).toBeEnabled();
    expect(screen.getByText("追加採譜が必要")).toBeVisible();
    expect(
      screen.getByText("ONにするとdrums無加算採譜を実行します: bass"),
    ).toBeVisible();
  });

  it("disables collection when no guided primary result is saved", () => {
    render(
      <PostTranscriptionOptions
        settings={settings}
        appliedSettings={settings}
        queue={{
          status: "idle",
          runningOption: null,
          pendingOptions: [],
          jobStatus: null,
          completed: 0,
          total: 0,
          detail: null,
          error: null,
        }}
        disabled={false}
        timingGuideReferences={{
          hasApplicablePrimary: false,
          missingInputNames: [],
          available: false,
        }}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText(
        /ドラム成分の追加による音高の誤検出を削減する/,
      ),
    ).toBeDisabled();
    expect(screen.getByText("参照結果なし")).toBeVisible();
  });

});
