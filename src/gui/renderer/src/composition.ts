/**
 * IME composition guard, per the text-input-and-IME conventions. Any key handler
 * that competes with text entry — type-ahead, Space/Enter activation, single-key
 * shortcuts — must do nothing while a composition is in progress, because those
 * keys belong to the IME then (Enter commits the candidate, arrows move through
 * candidates, etc.). Per-app helper; not a cross-app primitive.
 *
 * Two signals are combined. Each event's own `isComposing` is the primary read;
 * but WebKit can fire `compositionend` *before* the final `keydown`, so that last
 * keystroke would see `isComposing === false` and slip through. A document-level
 * flag covers that seam: it goes true on `compositionstart` and clears one
 * animation frame *after* `compositionend`, so the trailing keydown is still
 * guarded.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

// Document-level composition flag with a one-frame tail after compositionend.
let composing = false;
let clearHandle: number | undefined;

if (typeof window !== "undefined") {
  window.addEventListener("compositionstart", () => {
    composing = true;
    if (clearHandle !== undefined) cancelAnimationFrame(clearHandle);
    clearHandle = undefined;
  });
  window.addEventListener("compositionend", () => {
    if (clearHandle !== undefined) cancelAnimationFrame(clearHandle);
    // Hold the flag one frame past compositionend so the trailing keydown (WebKit
    // fires it after compositionend) is still treated as part of the composition.
    clearHandle = requestAnimationFrame(() => {
      composing = false;
      clearHandle = undefined;
    });
  });
}

/** True while an IME composition owns this keystroke. Accepts either a React
 *  synthetic event (type-ahead, listbox keys) or a raw DOM event (Radix's
 *  `onEscapeKeyDown` hands the shell a native one). Reads the document-level flag
 *  (which covers the post-`compositionend` WebKit seam), then the event's own
 *  standard `isComposing`, with the legacy `keyCode === 229` as a defensive
 *  fallback (deprecated, read optionally so its eventual removal degrades to
 *  undefined rather than breaking the guard). */
export function isComposing(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  if (composing) return true;
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  if (native.isComposing) return true;
  return (native as { keyCode?: number }).keyCode === 229;
}
