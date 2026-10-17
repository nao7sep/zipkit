/**
 * The options → ArchiveSpec mapping: the GUI's format-coercion edge. It turns
 * the visible option state into a typed spec; the SDK still owns all validation
 * and every default not set here. Pure
 * (no Electron, no Node, no SDK runtime), so it is unit-tested directly.
 */

import type { ArchivePolicy, ArchiveSpec, DeepPartial, NameAction } from "../../sdk/types.js";
import type { LanguagePreference } from "./i18n/languages.js";

/** The visible option state for one job. Defaults mirror the SDK's own defaults. */
export interface GuiOptions {
  /** Built-in OS-junk preset on. */
  junk: boolean;
  /** Make every name-portability issue block (error) instead of being auto-fixed. */
  strict: boolean;
  /** Deflate level 1–9. */
  level: number;
  symlinks: "ignore" | "preserve" | "follow";
  emptyDirs: "keep" | "prune";
  /** Embed the `zipkit.json` manifest. */
  metadata: boolean;
  /** Record a per-file SHA-256 in the manifest. */
  hash: boolean;
  /** Archive comment (empty = none). */
  comment: string;
  /** Output directory the archive is written into ("" = beside the input). */
  outputDir: string;
  /** Explicit zip file name ("" = automatic, from the input). */
  fileName: string;
  /** Overwrite an existing output. */
  overwrite: boolean;
}

export const DEFAULT_OPTIONS: GuiOptions = {
  junk: true,
  strict: false,
  level: 6,
  symlinks: "ignore",
  emptyDirs: "keep",
  metadata: true,
  hash: true,
  comment: "",
  outputDir: "",
  fileName: "",
  overwrite: false,
};

/** The app theme (app-chrome conventions, Theme): System follows the OS
 *  appearance; Light and Dark force a theme. */
/**
 * The archive parameters: how a job cleans, compresses and records what it
 * archives. Settings holds them as every new job's defaults. The rest of
 * GuiOptions (where the archive goes, its name, whether it may replace a file,
 * its comment) belongs to one job and never comes from Settings.
 */
export const PARAMETER_KEYS = ["junk", "strict", "level", "symlinks", "emptyDirs", "metadata", "hash"] as const satisfies readonly (keyof GuiOptions)[];
export type ArchiveParameters = Pick<GuiOptions, (typeof PARAMETER_KEYS)[number]>;

/** Just the parameters of a job's options. */
export function parametersOf(options: ArchiveParameters): ArchiveParameters {
  return Object.fromEntries(PARAMETER_KEYS.map((key) => [key, options[key]])) as unknown as ArchiveParameters;
}

export const DEFAULT_PARAMETERS: ArchiveParameters = parametersOf(DEFAULT_OPTIONS);

/** Whether two option states agree on every parameter, so a job still uses
 *  the defaults whatever its own destination, name and comment. */
export function parametersEqual(a: ArchiveParameters, b: ArchiveParameters): boolean {
  return PARAMETER_KEYS.every((key) => a[key] === b[key]);
}

/** A new job's options: the default parameters, with nothing of its own yet. */
export function newJobOptions(defaults: ArchiveParameters): GuiOptions {
  return { ...DEFAULT_OPTIONS, ...parametersOf(defaults) };
}

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** A missing or unrecognized stored theme resolves to System. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : "system";
}

let zoneList: readonly string[] | undefined;
/** The zones Settings offers after System: every zone the platform lists, with
 *  UTC, which the platform's list leaves out. */
export function displayZones(): readonly string[] {
  return (zoneList ??= [...Intl.supportedValuesOf("timeZone"), "UTC"].sort());
}

/** A saved display zone is one {@link displayZones} offers, or an older name for
 *  one of them; a fixed offset such as "+09:00", which newer runtimes accept, is not. */
export function isDisplayZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let canonical: string;
  try { canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return false; }
  return displayZones().includes(value) || displayZones().includes(canonical);
}

/** The persisted GUI settings: the new-job option defaults plus app-level appearance. */
export interface GuiSettings {
  /** The parameters every new job starts with. */
  defaults: ArchiveParameters;
  /** UI (chrome) font family. Family only; blank = the built-in default stack (the renderer's
   *  `--font-ui` variable). System fonts only — the renderer CSP forbids web fonts (`font-src 'self'`),
   *  and a free-text family naming installed fonts needs no `@font-face`. */
  uiFontFamily: string;
  /** The app theme, applied by the main process to nativeTheme.themeSource. */
  theme: ThemePreference;
  /** The interface language: System follows the computer's language. */
  language: LanguagePreference;
  /** The display zone (timestamp-conventions, Time zones): "system" follows the
   *  computer's zone on every launch; otherwise an IANA zone name. ZipKit reads
   *  no times that carry no zone, so it has no interpretation zone. */
  timeZone: string;
  /** Ask before a job leaves the list. On by default: a list item that goes on
   *  one click is a surprise in the fleet's apps. */
  confirmJobRemoval: boolean;
  /** How many items a Status card lists before it folds to its count. */
  cardRowLimit: number;
}

/** The range a Status card's item limit may take. */
export const CARD_ROW_LIMIT_RANGE = { min: 0, max: 100 } as const;

export function isCardRowLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= CARD_ROW_LIMIT_RANGE.min && value <= CARD_ROW_LIMIT_RANGE.max;
}

/** The config file's set keys. */
export const SETTINGS_KEYS = ["language", "timeZone", "theme", "uiFontFamily", "confirmJobRemoval", "cardRowLimit", "defaults"] as const satisfies readonly (keyof GuiSettings)[];

/** The sets the draft changed from the saved settings. */
export function changedSettings(before: GuiSettings, draft: GuiSettings): Partial<GuiSettings> {
  const changed = SETTINGS_KEYS.filter((key) => (key === "defaults" ? !parametersEqual(before.defaults, draft.defaults) : before[key] !== draft[key]));
  return Object.fromEntries(changed.map((key) => [key, draft[key]])) as Partial<GuiSettings>;
}

export const DEFAULT_SETTINGS: GuiSettings = {
  defaults: DEFAULT_PARAMETERS,
  uiFontFamily: "",
  theme: "system",
  language: "system",
  timeZone: "system",
  confirmJobRemoval: true,
  cardRowLimit: 5,
};

/** Build the `ArchiveSpec` for the given inputs and option state. Only the fields
 *  the UI controls are set; the SDK fills the rest from its defaults. The output
 *  path is NOT set here — it is composed from `outputDir`/`fileName` in the main
 *  process (`resolveOutputPath`), which needs the host path/home logic the
 *  Node-free shared layer cannot import. */
export function buildSpec(inputs: string[], o: GuiOptions): ArchiveSpec {
  const policy: DeepPartial<ArchivePolicy> = {
    junk: o.junk ? "builtin" : "none",
    symlinks: o.symlinks,
    emptyDirs: o.emptyDirs,
    compression: { level: o.level },
    metadata: o.metadata ? { hash: o.hash } : false,
  };
  if (o.strict) {
    const e: NameAction = "error";
    policy.names = {
      nfc: e,
      invalidChars: e,
      controlChars: e,
      trailingDotSpace: e,
      reserved: e,
      suspicious: "error",
    };
  }

  const spec: ArchiveSpec = { inputs, policy };
  if (o.overwrite) spec.overwrite = true;
  if (o.comment.trim() !== "") spec.comment = o.comment;
  return spec;
}

/**
 * The option fields that change a *dry run's* result — which entries are scanned,
 * the portability findings, the resolved output path, and the writable/overwrite
 * gate. Compression `level`, the archive `comment`, and the manifest `hash` are
 * write-time only: they never alter the plan, so editing them must NOT re-plan
 * (re-planning just to re-emit an identical report is the redundant dry run we
 * avoid). Keep this list in step with what {@link buildSpec} and the output
 * composition actually feed the plan.
 */
const PLAN_AFFECTING: (keyof GuiOptions)[] = [
  "junk",
  "strict",
  "symlinks",
  "emptyDirs",
  "metadata",
  "outputDir",
  "fileName",
  "overwrite",
];

/** Whether two option states differ in a way that requires a fresh dry run. */
export function planAffectingChanged(a: GuiOptions, b: GuiOptions): boolean {
  return PLAN_AFFECTING.some((k) => a[k] !== b[k]);
}

/** Whether two option states are identical across every field (all GuiOptions
 *  fields are primitives, so `===` per field is a full comparison). Used to decide
 *  whether a job is still on the defaults vs customized. */
export function optionsEqual(a: GuiOptions, b: GuiOptions): boolean {
  return (Object.keys(DEFAULT_OPTIONS) as (keyof GuiOptions)[]).every((k) => a[k] === b[k]);
}
