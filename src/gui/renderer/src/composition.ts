/**
 * IME composition guard, per the text-input-and-IME conventions. Any key handler
 * that competes with text entry — type-ahead, Space/Enter activation, single-key
 * shortcuts — must do nothing while a composition is in progress, because those
 * keys belong to the IME then (Enter commits the candidate, arrows move through
 * candidates, etc.). Per-app helper; not a cross-app primitive.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** True while an IME composition owns this keystroke. Accepts either a React
 *  synthetic event (type-ahead, listbox keys) or a raw DOM event (Radix's
 *  `onEscapeKeyDown` hands the shell a native one), so the guard reads from one
 *  place. Reads the standard `isComposing`, with the legacy `keyCode === 229` as
 *  a defensive fallback (deprecated, read optionally so its eventual removal
 *  degrades to undefined rather than breaking the guard). */
export function isComposing(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  if (native.isComposing) return true;
  return (native as { keyCode?: number }).keyCode === 229;
}
