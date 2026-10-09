/** A step that did not finish within its bound; its work may still be running.
 *  Its own module, with no imports, so the managed-write thread can load it. */
export class StepTimeout extends Error {}
