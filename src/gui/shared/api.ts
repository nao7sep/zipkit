/**
 * The contextBridge surface the GUI exposes to the renderer as `window.zipkit`.
 *
 * An explicit interface defined here in `shared` — not `typeof api` from preload —
 * so the renderer references the type without importing preload (whose `electron`
 * import would drag Node types into the renderer program). Preload implements it
 * via `satisfies ZipKitGuiApi`. SDK types come from `src/sdk/types` (pure data,
 * no runtime, no Node) via `import type`.
 *
 * The plan/write split mirrors the SDK: the renderer asks for a `plan` (the
 * inspect step), then `write` executes the plan the main process is holding —
 * the live plan never round-trips, so its out-of-band writer instructions stay in
 * the main process where the write happens.
 */

import type { ArchiveSpec, CreateData, Finding, LogEvent, Severity } from "../../sdk/types.js";

/** The `mode:"plan"` payload — the dry run the GUI inspects. */
export type PlanData = Extract<CreateData, { mode: "plan" }>;
/** The `mode:"write"` payload — the post-write result (metadata, bytes, zip64). */
export type WriteData = Extract<CreateData, { mode: "write" }>;

export type { ArchiveSpec, Finding, LogEvent, Severity };

/** A structured SDK fault surfaced to the renderer (mirrors `ZipKitError`'s shape). */
export interface GuiError {
  type: string;
  code: string;
  message: string;
}

export type PlanResult = { ok: true; plan: PlanData } | { ok: false; error: GuiError };
export type WriteResult = { ok: true; data: WriteData } | { ok: false; error: GuiError };

export interface ZipKitGuiApi {
  /** Open a native picker; returns chosen absolute paths (empty if cancelled). */
  chooseInputs(): Promise<string[]>;
  /** Dry-run plan for a spec — the inspect step. The main process holds the
   *  resulting live plan for a subsequent `write`. */
  plan(spec: ArchiveSpec): Promise<PlanResult>;
  /** Write the live plan the main process is currently holding. */
  write(): Promise<WriteResult>;
  /** Cancel the in-flight plan or write at its next boundary. */
  cancel(): Promise<void>;
  /** Subscribe to the live SDK event stream; returns an unsubscribe function. */
  onEvent(callback: (event: LogEvent) => void): () => void;
}
