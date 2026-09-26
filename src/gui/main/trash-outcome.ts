import { message, sentences, type Message } from "../shared/i18n/translate.js";

/**
 * What a batch of Trash calls did, and the user-facing account of it. A path
 * lands in exactly one bucket: `moved` (the OS confirmed the move), `failed`
 * (the OS refused, or the call never started — the path is kept), or
 * `unconfirmed` (the job stopped waiting on a call that was still running, so
 * the move may yet complete; it is never described as kept).
 */

export interface TrashResult {
  moved: string[];
  failed: Array<{ path: string; message: string }>;
  unconfirmed: string[];
}

/** True when every path's move was confirmed. */
export function trashConfirmed(result: TrashResult): boolean {
  return result.failed.length === 0 && result.unconfirmed.length === 0;
}

/** The account of a batch of originals that was not fully confirmed, e.g.
 *  "1 original was moved to recoverable Trash. 1 original was kept.", as one
 *  counted sentence per bucket so each keeps its own plural form. */
export function describeOriginalsTrash(result: TrashResult): Message {
  const parts = [message("trash.moved", { count: result.moved.length })];
  if (result.failed.length > 0) parts.push(message("trash.kept", { count: result.failed.length }));
  if (result.unconfirmed.length > 0) {
    parts.push(message("trash.unconfirmed", { count: result.unconfirmed.length }));
  }
  return sentences(parts)!;
}
