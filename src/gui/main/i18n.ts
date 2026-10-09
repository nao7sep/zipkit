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

import { readFile } from "node:fs/promises";
import { MANAGED_IO_WAIT_MS, managedIO } from "./managed-io.js";
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
import { loadCatalogue } from "../shared/i18n/catalogues.js";
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
export async function readConfigText(file: string): Promise<string | null> {
  try {
    return await managedIO(file, (signal) => readFile(file, { encoding: "utf8", signal }), MANAGED_IO_WAIT_MS);
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
// System removes the entry, so the computer's own list applies again. Only the
// packaged app does this: an unpackaged run shares the Electron runtime's own
// domain with every other app in development.
const APPLE_LANGUAGES = "AppleLanguages";

function ownsAppKitLanguages(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

function computerLanguages(): string[] {
  if (ownsAppKitLanguages()) {
    // The entry this app wrote shadows the computer's list; clear it first so
    // System reads what the computer prefers, then write it back below.
    systemPreferences.removeUserDefault(APPLE_LANGUAGES);
  }
  return app.getPreferredSystemLanguages();
}

function alignAppKit(preference: LanguagePreference, onError: (error: unknown) => void): void {
  if (!ownsAppKitLanguages()) return;
  try {
    if (preference === "system") systemPreferences.removeUserDefault(APPLE_LANGUAGES);
    else systemPreferences.setUserDefault(APPLE_LANGUAGES, "array", [preference]);
  } catch (error) {
    onError(error);
  }
}

async function build(systemLanguage: Language, systemLocale: string | null, preference: LanguagePreference): Promise<LanguageState> {
  const language = effectiveLanguage(preference, systemLanguage);
  await loadCatalogue(language);
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
export async function settleLanguage(preference: LanguagePreference, onError: (error: unknown) => void): Promise<void> {
  const computer = readComputer();
  state = await build(computer.systemLanguage, computer.systemLocale, preference);
  alignAppKit(preference, onError);
}

/** The translator for a failure reported before the language was settled: it
 *  speaks the computer's language, and leaves AppKit's entry alone for the
 *  launch that can read the saved choice. */
export async function settledTranslator(): Promise<Translator> {
  if (!state) {
    const computer = readComputer();
    const built = await build(computer.systemLanguage, computer.systemLocale, "system");
    state ??= built;
  }
  return state.translator;
}

/** The translator main draws its own surfaces with, once the language is settled. */
export function mainTranslator(): Translator {
  if (!state) throw new Error("The interface language is not settled yet");
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

let applying = 0;

/** Applies a saved choice: the window and every native surface follow at once.
 *  Of overlapping calls, the last one wins. */
export async function applyLanguagePreference(value: unknown, onError: (error: unknown) => void): Promise<void> {
  const request = ++applying;
  await settledTranslator();
  const preference = normalizeLanguagePreference(value);
  if (preference === state!.preference) return;
  const { systemLanguage, systemLocale } = state!;
  const next = await build(systemLanguage, systemLocale, preference);
  if (request !== applying) return;
  const previous = state!.translator.language;
  state = next;
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
