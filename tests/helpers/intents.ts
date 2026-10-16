import type { JobIntent } from "../../src/gui/shared/queue.js";

/** Keep the originals without verifying: the old plain save. */
export const SAVE: JobIntent = { verify: false, originals: "keep" };
/** Verify, then move the originals to Trash. */
export const TRASH: JobIntent = { verify: true, originals: "trash" };
/** Verify, then delete the originals permanently. */
export const DELETE: JobIntent = { verify: true, originals: "delete" };
