/**
 * Pane-layout persistence: the user's adjusted column widths, saved so the panes
 * reopen as the user left them. The file lives at `layout.json` under zipkit's
 * storage root (`ZIPKIT_HOME` or `~/.zipkit`, resolved by the SDK's
 * {@link storageRoot}, beside the queue, settings, and logs). Kept in its own
 * file — separate from the new-job-defaults `config.json` — because layout and
 * archive defaults are unrelated concerns. Parsing is pure and defensive (clamps
 * into bounds, falls back to the default layout, never throws); file I/O is the
 * best-effort edge and its failures are logged by the caller.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "../../sdk/storage.js";
import { DEFAULT_LAYOUT, clampLayout, type PaneLayout } from "../shared/layout.js";

/** The layout file under the resolved storage root. Computed lazily so
 *  `ZIPKIT_HOME` is read after the environment is set (storage-path convention). */
function layoutFile(): string {
  return path.join(storageRoot(), "layout.json");
}

/** Parse layout-file text into a clamped {@link PaneLayout}. Pure; never throws. */
export function parseLayout(text: string): PaneLayout {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
  const layout = (doc as { layout?: unknown } | null)?.layout;
  if (layout === null || typeof layout !== "object") return { ...DEFAULT_LAYOUT };
  return clampLayout({ ...DEFAULT_LAYOUT, ...(layout as Partial<PaneLayout>) });
}

/** Serialize a layout to file text. Pure. */
export function serializeLayout(layout: PaneLayout): string {
  return JSON.stringify({ version: 1, layout: clampLayout(layout) }, null, 2);
}

/** Load the persisted layout; the default layout if there is no readable file. */
export async function loadLayout(): Promise<PaneLayout> {
  try {
    return parseLayout(await readFile(layoutFile(), "utf8"));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persist the layout atomically (temp file + rename). The temp is `<stem>-<nanoid>.tmp`
 *  in the same directory (storage-path conventions' derived-filename grammar). Throws
 *  on write failure; the caller logs it. */
export async function saveLayout(layout: PaneLayout): Promise<void> {
  const file = layoutFile();
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.parse(file).name}-${randomUUID()}.tmp`);
  await writeFile(tmp, serializeLayout(layout), "utf8");
  await rename(tmp, file);
}
