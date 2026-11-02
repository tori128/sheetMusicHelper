import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageSelect } from "./components/LanguageSelect";
import {
  DISPLAY_LANGUAGE_STORAGE_KEY,
  LanguageProvider,
  Localized,
  readAppLanguage,
} from "./i18n";

function renderWithLanguage(children: ReactNode) {
  return render(<LanguageProvider>{children}</LanguageProvider>);
}

describe("display language", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.lang = "";
  });

  it("uses Japanese until the user selects another language", () => {
    renderWithLanguage(
      <Localized>
        <button aria-label="設定">新規プロジェクト</button>
        <LanguageSelect />
      </Localized>,
    );

    expect(screen.getByRole("button", { name: "設定" })).toHaveTextContent(
      "新規プロジェクト",
    );
    expect(screen.getByLabelText("Language")).toHaveValue("ja");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("persists English and updates text and accessible names immediately", () => {
    renderWithLanguage(
      <Localized>
        <button aria-label="設定">新規プロジェクト</button>
        <LanguageSelect />
      </Localized>,
    );

    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "en" },
    });

    expect(screen.getByRole("button", { name: "Settings" })).toHaveTextContent(
      "New project",
    );
    expect(window.localStorage.getItem(DISPLAY_LANGUAGE_STORAGE_KEY)).toBe(
      "en",
    );
    expect(readAppLanguage()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("supports Simplified Chinese", () => {
    renderWithLanguage(
      <Localized>
        <span>音源ファイルを選択</span>
        <LanguageSelect />
      </Localized>,
    );

    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "zh" },
    });

    expect(screen.getByText("选择音频文件")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("leaves user-provided text marked as non-localized unchanged", () => {
    window.localStorage.setItem(DISPLAY_LANGUAGE_STORAGE_KEY, "en");
    renderWithLanguage(
      <Localized>
        <span data-localize="false">ピアノ</span>
      </Localized>,
    );

    expect(screen.getByText("ピアノ")).toBeInTheDocument();
  });
});
