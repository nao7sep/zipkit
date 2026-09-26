// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppHeader } from "../../../src/gui/renderer/src/components/AppHeader";
import { MainProcessLanguage } from "../../../src/gui/renderer/src/i18n/I18nContext";
import { planReport } from "../../../src/gui/renderer/src/view";
import { ZipKit } from "../../../src/sdk/index";
import type { LanguageEnvironment, PlanData } from "../../../src/gui/shared/api";
import { createTranslator } from "../../../src/gui/shared/i18n/translate";

afterEach(cleanup);

describe("the interface language main settles on", () => {
  it("renders nothing until main answers, then follows a saved change live", async () => {
    let announce: (environment: LanguageEnvironment) => void = () => {};
    let answer: (environment: LanguageEnvironment) => void = () => {};
    Object.defineProperty(window, "zipkit", {
      configurable: true,
      value: {
        getLanguageEnvironment: () => new Promise<LanguageEnvironment>((resolve) => { answer = resolve; }),
        onLanguageChanged: (callback: (environment: LanguageEnvironment) => void) => {
          announce = callback;
          return () => {};
        },
      },
    });

    const { container } = render(
      <MainProcessLanguage>
        <AppHeader onOpenSettings={() => {}} onOpenShortcuts={() => {}} onOpenAbout={() => {}} />
      </MainProcessLanguage>,
    );
    // No English flashes before the language is known.
    expect(container.textContent).toBe("");

    await act(async () => answer({ language: "en", locale: "en" }));
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");

    const ja = createTranslator("ja");
    await act(async () => announce({ language: "ja", locale: "ja" }));
    expect(screen.getByRole("button", { name: ja.t("header.menu") })).toBeTruthy();
    expect(document.documentElement.lang).toBe("ja");
  });
});

describe("the SDK's words at the GUI boundary", () => {
  it("still recognizes the exclusion reasons a real plan reports", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zipkit-l10n-"));
    try {
      mkdirSync(path.join(root, "src", "empty"), { recursive: true });
      writeFileSync(path.join(root, "src", "kept.txt"), "x");
      const plan = (await new ZipKit().plan({
        inputs: [path.join(root, "src")],
        output: path.join(root, "out.zip"),
        policy: { emptyDirs: "prune" },
      })) as PlanData;
      const lines = planReport(plan, createTranslator("en"));
      // A drifted SDK phrase would fall back to "Excluded: <phrase>".
      expect(lines.map((line) => line.text)).toContain("Empty directory pruned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
