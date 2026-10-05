/**
 * Pane-layout persistence: the user's adjusted column widths, saved so the panes
 * reopen as the user left them — the main window's side columns and the Records
 * window's list pane. The file lives at `layout.json` under zipkit's
 * storage root (`ZIPKIT_DATA_DIR` or `~/.zipkit`, resolved by the SDK's
 * {@link storageRoot}, beside the queue, settings, and logs). Kept in its own
 * file — separate from the new-job-defaults `config.json` — because layout and
 * archive defaults are unrelated concerns. Parsing validates the schema then
 * clamps into bounds; invalid bytes are quarantined and real I/O errors surface.
 *
 * Main holds the layout last loaded or saved, so each window saves only its own
 * widths and keeps the other's; the writes go out one at a time, in order.
 */

import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_LAYOUT, RECORDS_LIST_WIDTH, clampLayout, clampRecordsListWidth, type PaneLayout } from "../shared/layout.js";
import { nullLog, type AppLog } from "./log.js";
import { FORMAT_VERSIONS } from "./formatVersions.js";
import { InvalidManagedJsonError, isPlainObject, loadManagedJson, managedJsonText, writeManagedJson, type ManagedJsonLoad } from "./managedJson.js";

/** Every width the layout file holds: the main window's panes and the Records
 *  window's list pane. */
export interface StoredLayout extends PaneLayout {
  recordsListWidth: number;
}

/** The layout file under the resolved storage root. Computed lazily so
 *  `ZIPKIT_DATA_DIR` is read after the environment is set (storage-path convention). */
function layoutFile(): string {
  return path.join(storageRoot(), "layout.json");
}

/** A fresh copy of the default layout — the value returned when there is no readable or usable file.
 *  A new object each call so a caller mutating it (a drag resize) can never mutate the shared
 *  {@link DEFAULT_LAYOUT} baseline; mirrors settings.ts's `freshSettings`. */
function freshLayout(): StoredLayout {
  return { ...DEFAULT_LAYOUT, recordsListWidth: RECORDS_LIST_WIDTH.default };
}

/** Validate the layout file's root object into a clamped {@link StoredLayout}. */
export function parseLayout(root: Record<string, unknown>): StoredLayout {
  const layout = root.layout;
  if (!isPlainObject(layout)) throw new InvalidManagedJsonError("layout.json", "layout must be an object");
  for (const key of ["jobsWidth", "progressWidth", "recordsListWidth"] as const) {
    if (layout[key] !== undefined && typeof layout[key] !== "number") {
      throw new InvalidManagedJsonError("layout.json", `layout.${key} must be a number`);
    }
  }
  const recordsListWidth = layout.recordsListWidth as number | undefined;
  return {
    ...clampLayout({ ...DEFAULT_LAYOUT, ...(layout as Partial<PaneLayout>) }),
    recordsListWidth: clampRecordsListWidth(recordsListWidth ?? RECORDS_LIST_WIDTH.default),
  };
}

/** Serialize a layout to file text. Pure. */
export function serializeLayout(layout: StoredLayout): string {
  return managedJsonText(FORMAT_VERSIONS.layout, {
    layout: { ...clampLayout(layout), recordsListWidth: clampRecordsListWidth(layout.recordsListWidth) },
  });
}

let current: StoredLayout = freshLayout();
let writes: Promise<void> = Promise.resolve();

/** Load the persisted layout; the default layout if there is no readable file. A present-but-corrupt
 *  file (invalid JSON) is quarantined aside — never silently reset in place — before the default
 *  layout is returned; a quarantine-rename failure propagates rather than degrading to the default
 *  over the corrupt bytes. The shared {@link loadManagedJson} owns that quarantine-outside-the-catch
 *  shape, identical to config.json and queue.json. Layout is disposable view state, so callers leave
 *  its quarantine outcome log-only rather than raising a recovery dialog. */
export async function loadLayout(logger: AppLog = nullLog): Promise<ManagedJsonLoad<StoredLayout>> {
  const load = await loadManagedJson(layoutFile(), FORMAT_VERSIONS.layout, parseLayout, freshLayout, logger);
  current = { ...load.value };
  return load;
}

// Persist through the shared managed-text atomic write (temp file + rename), after
// every write before it. Layout is volatile view state, so it is not recorded to
// the data-backup store. Rejects on write failure; the caller logs it.
function persist(next: StoredLayout): Promise<void> {
  current = next;
  const text = serializeLayout(next);
  const write = writes.catch(() => {}).then(() => writeManagedJson(layoutFile(), text, { record: false }));
  writes = write;
  return write;
}

/** Persist the main window's pane widths, keeping the Records window's. */
export function saveLayout(layout: PaneLayout): Promise<void> {
  return persist({ ...current, ...clampLayout(layout) });
}

/** The Records window's list width, as last loaded or saved. */
export function recordsListWidth(): number {
  return current.recordsListWidth;
}

/** Persist the Records window's list width, keeping the main window's panes;
 *  returns the width stored. */
export async function saveRecordsListWidth(width: number): Promise<number> {
  const stored = clampRecordsListWidth(width);
  await persist({ ...current, recordsListWidth: stored });
  return stored;
}
