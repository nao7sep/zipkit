import { CATALOGUES, type Catalogue, type MessageKey } from "./catalogues.js";
import type { Language } from "./languages.js";

// A value filled into a placeholder: a number is formatted for the locale, and
// a message is rendered in the same language (a reason inside a sentence).
export type MessageValue = string | number | Message;
export type MessageValues = { [name: string]: MessageValue };

// Text held in state (job results, action results, notices, error
// presentations) is a key plus values, never a finished string, so it renders
// in whatever language is current when it is shown. Both processes build
// these; only a surface that draws text renders them.
export type Message = {
  key: MessageKey;
  values?: MessageValues;
};

export function message(key: MessageKey, values?: MessageValues): Message {
  return values === undefined ? { key } : { key, values };
}

// Several messages shown as one line of consecutive sentences, joined through
// one catalogue entry so each language chooses its own separator. Null when
// there is nothing to show.
export function sentences(parts: readonly Message[]): Message | null {
  if (parts.length === 0) return null;
  return parts.reduceRight((rest, first) => message("common.sentences", { first, rest }));
}

const PLACEHOLDER = /\{(\w+)\}/g;

export type Translator = {
  language: Language;
  locale: string;
  t: (key: MessageKey, values?: MessageValues) => string;
  text: (message: Message) => string;
  // The entry split around its placeholders: literal text at even indexes and
  // placeholder names at odd ones, for a surface that fills them with markup.
  parts: (key: MessageKey) => string[];
  number: (value: number) => string;
  // An instant, as a date and time.
  dateTime: (date: Date) => string;
  // An instant to the second, for a log line.
  logTime: (date: Date) => string;
  // Items run together the way the language lists them ("a, b, c").
  list: (items: readonly string[]) => string;
};

export function createTranslator(language: Language, locale: string = language): Translator {
  const catalogue: Catalogue = CATALOGUES[language];
  const numberFormat = new Intl.NumberFormat(locale);
  const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const logTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
  const listFormat = new Intl.ListFormat(language, { style: "narrow", type: "conjunction" });
  const pluralRules = new Intl.PluralRules(language);

  function template(key: MessageKey, values: MessageValues | undefined): string {
    const entry = catalogue[key];
    if (typeof entry === "string") {
      return entry;
    }
    // A key the catalogue does not carry shows as itself rather than taking the
    // window down; the catalogue gate and the on-screen-key check both fail on
    // it, so it cannot reach a release unnoticed.
    if (entry === undefined || entry === null) {
      return key;
    }
    // A plural entry holds one form per CLDR category the language uses; the
    // catalogue gate guarantees the category the rules select is present.
    const count = typeof values?.count === "number" ? values.count : 0;
    const forms = entry as Record<string, string>;
    return forms[pluralRules.select(count)] ?? forms.other ?? key;
  }

  function format(value: MessageValue): string {
    if (typeof value === "number") return numberFormat.format(value);
    if (typeof value === "string") return value;
    return t(value.key, value.values);
  }

  function t(key: MessageKey, values?: MessageValues): string {
    return template(key, values).replace(PLACEHOLDER, (whole, name: string) =>
      values !== undefined && name in values ? format(values[name]!) : whole,
    );
  }

  return {
    language,
    locale,
    t,
    text: (message) => t(message.key, message.values),
    parts: (key) => template(key, undefined).split(PLACEHOLDER),
    number: (value) => numberFormat.format(value),
    dateTime: (date) => dateTimeFormat.format(date),
    logTime: (date) => logTimeFormat.format(date),
    list: (items) => listFormat.format(items),
  };
}
