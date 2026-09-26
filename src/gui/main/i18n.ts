/**
 * The interface language, owned by the main process (fleet localization). Main
 * resolves the saved choice against the computer's language, draws its own
 * native surfaces (the application menu, the native dialogs, the app message
 * windows) from the shared catalogues, and hands the window the language it
 * settled on, so both processes always agree.
 *
 * The computer's languages are read once, at launch; System resolves against
 * that reading for the whole session.
 */

import { readFileSync } from "node:fs";
import { app, BrowserWindow, systemPreferences } from "electron";
import {
  effectiveLanguage,
  formattingLocale,
  normalizeLanguagePreference,
  systemLanguage as resolveSystemLanguage,
  type Language,
  type LanguageEnvironment,
  type LanguagePreference,
} from "../shared/i18n/languages.js";
import { createTranslator, type Translator } from "../shared/i18n/translate.js";
import { LANGUAGE_CHANGED_CHANNEL } from "../shared/api.js";

interface LanguageState {
  systemLanguage: Language;
  systemLocale: string | null;
  preference: LanguagePreference;
  translator: Translator;
}

let state: LanguageState | null = null;
const listeners = new Set<(translator: Translator) => void>();

/**
 * The saved choice in config.json's text, read without the settings store so
 * the menu can be drawn in it before the store loads: a missing, unreadable or
 * corrupt file is System, and recovering a corrupt one stays with the store.
 */
export function readSavedPreference(configText: string | null): LanguagePreference {
  if (configText === null) return "system";
  try {
    const parsed = JSON.parse(configText) as { language?: unknown } | null;
    return normalizeLanguagePreference(parsed?.language);
  } catch {
    return "system";
  }
}

/** config.json's text, or null when it cannot be read. */
export function readConfigText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// macOS draws some Edit menu items itself (Emoji & Symbols, Start Dictation,
// AutoFill, Writing Tools, Services) in the language AppKit settles on before
// any JavaScript runs, from AppleLanguages. Electron offers no volatile argument
// domain, so ZipKit keeps the interface language in its own defaults domain
// (never the global one): AppKit, and Chromium's own strings, pick it up at the
// next launch, as the conventions allow for a language saved mid-session.
// System removes the entry, so the computer's own list applies again.
const APPLE_LANGUAGES = "AppleLanguages";

function computerLanguages(): string[] {
  if (process.platform === "darwin") {
    // The entry this app wrote shadows the computer's list; clear it first so
    // System reads what the computer prefers, then write it back below.
    systemPreferences.removeUserDefault(APPLE_LANGUAGES);
  }
  return app.getPreferredSystemLanguages();
}

function alignAppKit(preference: LanguagePreference, onError: (error: unknown) => void): void {
  if (process.platform !== "darwin") return;
  try {
    if (preference === "system") systemPreferences.removeUserDefault(APPLE_LANGUAGES);
    else systemPreferences.setUserDefault(APPLE_LANGUAGES, "array", [preference]);
  } catch (error) {
    onError(error);
  }
}

function build(systemLanguage: Language, systemLocale: string | null, preference: LanguagePreference): LanguageState {
  const language = effectiveLanguage(preference, systemLanguage);
  return {
    systemLanguage,
    systemLocale,
    preference,
    translator: createTranslator(language, formattingLocale(language, systemLocale)),
  };
}

function readComputer(): { systemLanguage: Language; systemLocale: string | null } {
  return {
    systemLanguage: resolveSystemLanguage(computerLanguages()),
    systemLocale: app.getSystemLocale() || null,
  };
}

/** Settles the language once the app is ready, before any window or native
 *  menu exists. Called once per launch. */
export function settleLanguage(preference: LanguagePreference, onError: (error: unknown) => void): void {
  const computer = readComputer();
  state = build(computer.systemLanguage, computer.systemLocale, preference);
  alignAppKit(preference, onError);
}

/** The translator main draws its own surfaces with. A failure reported before
 *  the saved choice could be read speaks the computer's language, and leaves
 *  AppKit's entry alone for the launch that can read it. */
export function mainTranslator(): Translator {
  if (!state) {
    const computer = readComputer();
    state = build(computer.systemLanguage, computer.systemLocale, "system");
  }
  return state.translator;
}

export function languageEnvironment(): LanguageEnvironment {
  const translator = mainTranslator();
  return { language: translator.language, locale: translator.locale };
}

/** Native surfaces that hold words register here and redraw on a change. */
export function onLanguageChanged(listener: (translator: Translator) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Applies a saved choice: the window and every native surface follow at once. */
export function applyLanguagePreference(value: unknown, onError: (error: unknown) => void): void {
  mainTranslator(); // settles on the computer's language if nothing has yet
  const current = state!;
  const preference = normalizeLanguagePreference(value);
  if (preference === current.preference) return;
  const previous = current.translator.language;
  state = build(current.systemLanguage, current.systemLocale, preference);
  alignAppKit(preference, onError);
  if (state.translator.language === previous) return;
  const translator = state.translator;
  for (const listener of listeners) {
    try {
      listener(translator);
    } catch (error) {
      onError(error);
    }
  }
  const environment = languageEnvironment();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(LANGUAGE_CHANGED_CHANNEL, environment);
  }
}
