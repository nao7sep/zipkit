/**
 * The contextBridge surface the GUI exposes to the renderer as `window.zipkit`.
 *
 * It is an explicit interface defined here in `shared` — not `typeof api` lifted
 * from preload — so the renderer can reference the type without importing the
 * preload module, whose `electron` import would otherwise drag Node types into
 * the renderer program and defeat its Node isolation. Preload implements this
 * interface via `satisfies ZipKitGuiApi`, so the two can never drift.
 *
 * SDK types are pulled from `src/sdk/types` (pure data, no runtime, no Node) with
 * `import type`, so nothing in the SDK's Node-using implementation reaches the
 * renderer's web typecheck.
 */

import type { ArchiveSpec, CreateData, Finding, Severity } from "../../sdk/types.js";

/** The `mode:"plan"` payload — the dry run the GUI inspects before any write. */
export type PlanData = Extract<CreateData, { mode: "plan" }>;

export type { ArchiveSpec, Finding, Severity };

/** A structured SDK fault surfaced to the renderer (mirrors `ZipKitError`'s shape)
 *  so a failed verb is a typed value, never an opaque IPC rejection. */
export interface GuiError {
  type: string;
  code: string;
  message: string;
}

/** A plan request resolves to the plan or a structured fault — the renderer
 *  always gets a value it can render, never a thrown channel error. */
export type PlanResult = { ok: true; plan: PlanData } | { ok: false; error: GuiError };

export interface ZipKitGuiApi {
  /** Open a native directory picker; returns chosen absolute paths (empty if cancelled). */
  chooseInputs(): Promise<string[]>;
  /** Dry-run plan for a spec — the inspect step the screen rests on. */
  plan(spec: ArchiveSpec): Promise<PlanResult>;
}
