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

function wasWere(n: number): string {
  return n === 1 ? "was" : "were";
}

/** The account of a batch of originals that was not fully confirmed, e.g.
 *  "1 original was moved to recoverable Trash; 1 was kept." */
export function describeOriginalsTrash(result: TrashResult): string {
  const moved = result.moved.length;
  const parts = [`${moved} original${moved === 1 ? "" : "s"} ${wasWere(moved)} moved to recoverable Trash`];
  const kept = result.failed.length;
  if (kept > 0) parts.push(`${kept} ${wasWere(kept)} kept`);
  const unconfirmed = result.unconfirmed.length;
  if (unconfirmed > 0) {
    parts.push(`${unconfirmed} ${wasWere(unconfirmed)} still being moved and may yet reach recoverable Trash`);
  }
  return `${parts.join("; ")}.`;
}
