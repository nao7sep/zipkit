import { message, sentences, type Message } from "../shared/i18n/translate.js";

/**
 * What a batch of Trash or delete calls did, and the user-facing account of
 * it. A path lands in exactly one bucket: `moved` (the OS confirmed the move or
 * the deletion), `gone` (it was no longer there when its turn came: something
 * outside ZipKit had already moved or deleted it), or `failed` (the OS refused,
 * or the call never started — the path is kept).
 */

export interface TrashResult {
  moved: string[];
  failed: Array<{ path: string; message: string }>;
  /** Paths already gone when their turn came; absent when there were none. */
  gone?: string[];
}

/** True when no path was kept: each was moved, deleted, or already gone. */
export function trashConfirmed(result: TrashResult): boolean {
  return result.failed.length === 0;
}

/** The account of a batch of originals that was not fully removed, e.g.
 *  "1 original was moved to recoverable Trash. 1 original was kept.", as one
 *  counted sentence per bucket so each keeps its own plural form. */
export function describeOriginalsRemoval(result: TrashResult, method: "trash" | "delete"): Message {
  const trash = method === "trash";
  const gone = result.gone?.length ?? 0;
  const parts = result.moved.length > 0 || gone === 0
    ? [message(trash ? "trash.moved" : "originals.deleted", { count: result.moved.length })]
    : [];
  if (gone > 0) parts.push(message("originals.alreadyGone", { count: gone }));
  if (result.failed.length > 0) parts.push(message("trash.kept", { count: result.failed.length }));
  return sentences(parts)!;
}

/** The account of a confirmed removal: what was moved or deleted, and what had
 *  already gone outside ZipKit, each only when there is any. `before` counts
 *  originals found gone before the removal began. */
export function describeRemovalDone(result: TrashResult, method: "trash" | "delete", movedKey: "trash" | "action", before = 0): Message {
  const gone = (result.gone?.length ?? 0) + before;
  const key = method === "trash" ? (movedKey === "trash" ? "trash.moved" : "action.originalsTrashed") : "originals.deleted";
  const parts = result.moved.length > 0 || gone === 0 ? [message(key, { count: result.moved.length })] : [];
  if (gone > 0) parts.push(message("originals.alreadyGone", { count: gone }));
  return sentences(parts)!;
}
