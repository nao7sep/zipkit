import { createContext, createElement, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MessageKey } from "../../../shared/i18n/catalogues";
import { isLanguage, type Language, type LanguageEnvironment } from "../../../shared/i18n/languages";
import { createTranslator, type Translator as BaseTranslator } from "../../../shared/i18n/translate";

export type Translator = BaseTranslator & {
  // Like t, but a placeholder may be filled with markup (a <code> file name, say).
  rich: (key: MessageKey, values: Record<string, ReactNode>) => ReactNode;
};

export function rendererTranslator(language: Language, locale?: string): Translator {
  const base = createTranslator(language, locale);
  return {
    ...base,
    rich: (key, values) =>
      base.parts(key).map((part, index) =>
        index % 2 === 0
          ? part
          : createElement(Fragment, { key: index }, part in values ? values[part] : `{${part}}`),
      ),
  };
}

// English until a provider says otherwise, so a component rendered on its own
// (in a test, say) still has text.
const I18nContext = createContext<Translator>(rendererTranslator("en"));

export function I18nProvider({
  language,
  locale,
  children,
}: {
  language: Language;
  locale: string;
  children: ReactNode;
}) {
  const translator = useMemo(() => rendererTranslator(language, locale), [language, locale]);

  // <html lang> picks the right glyphs for Chinese, Japanese and Korean text and
  // tells the last-resort error boundary, which sits outside this provider,
  // which language to speak.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

/**
 * The language the main process settled on, followed live: main resolves the
 * saved choice and the computer's language, and tells the window when a saved
 * change moves it. Nothing renders until the language is known, so the first
 * words on screen are already in it.
 */
export function MainProcessLanguage({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<LanguageEnvironment | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.zipkit.onLanguageChanged((next) => setEnvironment(next));
    void window.zipkit
      .getLanguageEnvironment()
      .then((next) => {
        if (!cancelled) setEnvironment((current) => current ?? next);
      })
      // A failed read leaves English in its own format rather than no window.
      .catch(() => {
        if (!cancelled) setEnvironment((current) => current ?? { language: "en", locale: "en" });
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!environment) return null;
  return (
    <I18nProvider language={environment.language} locale={environment.locale}>
      {children}
    </I18nProvider>
  );
}

export function useI18n(): Translator {
  return useContext(I18nContext);
}

// For surfaces outside the provider: the language the document last declared.
export function documentTranslator(): Translator {
  const declared = document.documentElement.lang;
  return rendererTranslator(isLanguage(declared) ? declared : "en");
}
