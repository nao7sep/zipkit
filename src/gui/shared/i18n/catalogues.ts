import en from "./locales/en.json";
import type { Language } from "./languages.js";

// English defines the key set; every other catalogue carries every key, with
// plural entries keyed by the language's own CLDR categories. The catalogue
// gate (tests/i18n/catalogues.test.ts) checks keys, placeholders, plural forms,
// hidden characters, and untranslated English.
export type MessageKey = keyof typeof en;

export type CatalogueEntry = string | Readonly<Record<string, string>>;

export type Catalogue = Readonly<Record<MessageKey, CatalogueEntry>>;

export const ENGLISH: Catalogue = en;

// Typed on the module, so a catalogue missing an English key fails the type check.
const catalogueOf = (module: { default: Catalogue }): Catalogue => module.default;

// One dynamic import per catalogue, so each process loads only the interface
// language and English (localization-stack-conventions, Electron with React).
const LOADERS: Readonly<Record<Language, () => Promise<Catalogue>>> = {
  en: () => Promise.resolve(en),
  de: () => import("./locales/de.json").then(catalogueOf),
  es: () => import("./locales/es.json").then(catalogueOf),
  fr: () => import("./locales/fr.json").then(catalogueOf),
  it: () => import("./locales/it.json").then(catalogueOf),
  "pt-BR": () => import("./locales/pt-BR.json").then(catalogueOf),
  ru: () => import("./locales/ru.json").then(catalogueOf),
  ja: () => import("./locales/ja.json").then(catalogueOf),
  ko: () => import("./locales/ko.json").then(catalogueOf),
  "zh-Hans": () => import("./locales/zh-Hans.json").then(catalogueOf),
};

const loaded = new Map<Language, Catalogue>([["en", en]]);

export async function loadCatalogue(language: Language): Promise<Catalogue> {
  const cached = loaded.get(language);
  if (cached) return cached;
  const catalogue = await LOADERS[language]();
  loaded.set(language, catalogue);
  return catalogue;
}

// A catalogue already loaded; a translator is only ever built for one.
export function loadedCatalogue(language: Language): Catalogue {
  const catalogue = loaded.get(language);
  if (!catalogue) throw new Error(`The ${language} catalogue is not loaded`);
  return catalogue;
}
