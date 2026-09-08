/**
 * Pane-layout persistence: the user's adjusted column widths, saved so the panes
 * reopen as the user left them. The file lives at `layout.json` under zipkit's
 * storage root (`ZIPKIT_HOME` or `~/.zipkit`, resolved by the SDK's
 * {@link storageRoot}, beside the queue, settings, and logs). Kept in its own
 * file — separate from the new-job-defaults `config.json` — because layout and
 * archive defaults are unrelated concerns. Parsing validates the v1 schema then
 * clamps into bounds; invalid bytes are quarantined and real I/O errors surface.
 */

import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import {
  DEFAULT_LAYOUT,
  clampLayout,
  type PaneLayout,
  type WindowBounds,
  type WindowPlacementRecord,
} from "../shared/layout.js";
import { nullLog, type AppLog } from "./log.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, parseManagedObject, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";

/** The layout file under the resolved storage root. Computed lazily so
 *  `ZIPKIT_HOME` is read after the environment is set (storage-path convention). */
function layoutFile(): string {
  return path.join(storageRoot(), "layout.json");
}

/** A fresh copy of the default layout — the value returned when there is no readable or usable file.
 *  A new object each call so a caller mutating it (a drag resize) can never mutate the shared
 *  {@link DEFAULT_LAYOUT} baseline; mirrors settings.ts's `freshSettings`. */
function freshLayout(): PaneLayout {
  return { ...DEFAULT_LAYOUT };
}

interface LayoutDocument {
  layout: PaneLayout;
  windowPlacements: { main: WindowPlacementRecord | null };
}

let cache: LayoutDocument = { layout: freshLayout(), windowPlacements: { main: null } };
let writeQueue: Promise<void> = Promise.resolve();

function parseDocument(text: string): LayoutDocument {
  const root = parseManagedObject(text, "layout.json");
  const layout = root.layout;
  if (!isPlainObject(layout)) throw new InvalidManagedJsonError("layout.json", "layout must be an object");
  for (const key of ["jobsWidth", "progressWidth"] as const) {
    if (layout[key] !== undefined && typeof layout[key] !== "number") {
      throw new InvalidManagedJsonError("layout.json", `layout.${key} must be a number`);
    }
  }
  return {
    layout: clampLayout({ ...DEFAULT_LAYOUT, ...(layout as Partial<PaneLayout>) }),
    windowPlacements: normalizeWindowPlacements(root.windowPlacements),
  };
}

/** Parse and validate layout-file text into a clamped {@link PaneLayout}. */
export function parseLayout(text: string): PaneLayout {
  return parseDocument(text).layout;
}

/** Serialize a layout to file text. Pure. */
export function serializeLayout(layout: PaneLayout): string {
  return serializeDocument({ ...cache, layout: clampLayout(layout) });
}

function serializeDocument(document: LayoutDocument): string {
  return JSON.stringify({ version: 1, ...document }, null, 2);
}

/** Load the persisted layout; the default layout if there is no readable file. A present-but-corrupt
 *  file (invalid JSON) is quarantined aside — never silently reset in place — before the default
 *  layout is returned; a quarantine-rename failure propagates rather than degrading to the default
 *  over the corrupt bytes. The shared {@link loadManagedJson} owns that quarantine-outside-the-catch
 *  shape, identical to config.json and queue.json. Layout is disposable view state, so callers leave
 *  its quarantine outcome log-only rather than raising a recovery dialog. */
export async function loadLayout(logger: AppLog = nullLog): Promise<ManagedJsonLoad<PaneLayout>> {
  const loaded = await loadManagedJson(
    layoutFile(),
    parseDocument,
    () => ({ layout: freshLayout(), windowPlacements: { main: null } }),
    logger,
  );
  cache = loaded.value;
  return { ...loaded, value: loaded.value.layout };
}

/** Persist the layout through the shared managed-text atomic write (temp file + rename), recording the
 *  exact bytes to the data-backup store after the rename lands. layout.json is managed text and RECORDS
 *  on every save — geometry/throwaway UI state included: the data-backup conventions deliberately record
 *  all managed text and let per-path content-hash dedup absorb the churn of near-identical geometry
 *  saves (this is the new design, not the old "exclude volatile state" rule). Throws on write failure;
 *  the caller logs it. */
export async function saveLayout(layout: PaneLayout): Promise<void> {
  cache = { ...cache, layout: clampLayout(layout) };
  await persistCache();
}

export function getWindowPlacement(): WindowPlacementRecord | null {
  const placement = cache.windowPlacements.main;
  return placement ? structuredClone(placement) : null;
}

export async function saveWindowPlacement(placement: WindowPlacementRecord): Promise<void> {
  cache = { ...cache, windowPlacements: { main: structuredClone(placement) } };
  await persistCache();
}

function persistCache(): Promise<void> {
  const write = writeQueue.then(async () => {
    const snapshot = structuredClone(cache);
    await writeManagedJson(layoutFile(), serializeDocument(snapshot));
  });
  writeQueue = write.catch(() => {});
  return write;
}

function normalizeWindowPlacements(raw: unknown): LayoutDocument["windowPlacements"] {
  if (!isPlainObject(raw) || !isPlainObject(raw.main)) return { main: null };
  const mode = raw.main.mode === "normal" || raw.main.mode === "maximized" ? raw.main.mode : "normal";
  return { main: { normalBounds: normalizeBounds(raw.main.normalBounds), mode } };
}

function normalizeBounds(raw: unknown): WindowBounds | null {
  if (!isPlainObject(raw)) return null;
  const values = [raw.x, raw.y, raw.width, raw.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number };
}
