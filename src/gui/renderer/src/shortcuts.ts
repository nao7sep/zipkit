/**
 * The keyboard-shortcut catalog: one ordered, grouped source of truth, so the
 * Shortcuts dialog and the app-level key handler can never describe a binding
 * that does not exist. The app-level accelerators (Add a job, Create the selected
 * job's archive, Settings, Shortcuts — all Cmd/Ctrl combos) are handled in
 * App.tsx; the plain queue/list keys are display-only here — they are owned by the
 * JobListbox per the composite-control conventions. Pure data, no React/DOM.
 */

import type { GuiPlatform } from "../../shared/api";

export interface ShortcutItem {
  /** The key combination, spelled out per the display convention — modifier words
   *  not glyphs, symbol keys as words ("Cmd+Comma", not "Cmd+,"), full key names
   *  ("Escape", "PageUp"). The shared modifier is the running platform's single
   *  word ("Cmd" on macOS, "Ctrl" elsewhere). Tight "/" is an "either key"
   *  separator; spaced " / " joins independent chords. */
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

/** Alt is excluded because Chromium delivers Windows AltGr as Ctrl+Alt. */
export function hasMod(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey;
}

/**
 * On macOS, Ctrl inside a text field belongs to the text system whatever the
 * key is, so the Ctrl half of a dual-bound chord stands down there — one
 * blanket test, no per-chord key list (keyboard-shortcut-conventions). The
 * Cmd half is the binding and always fires.
 */
export function shadowsMacTextBinding(e: KeyboardEvent, isMac: boolean): boolean {
  return isMac && e.ctrlKey && !e.metaKey;
}

/**
 * One editable-target predicate for the whole app. The parentElement walk is
 * load-bearing: a rich-text target is a descendant of its contenteditable,
 * so a tagName-only test would let every chord through.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  let current = target instanceof HTMLElement ? target : null;
  while (current) {
    if (current.isContentEditable) return true;
    if (current.tagName === "TEXTAREA") return true;
    if (current.tagName === "INPUT") {
      const type = (current.getAttribute("type") ?? "text").toLowerCase();
      return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"].includes(type);
    }
    current = current.parentElement;
  }
  return false;
}

/** The platform's single modifier word for display: "Cmd" on macOS, "Ctrl"
 *  everywhere else. Never the combined "Cmd/Ctrl" in live UI. */
export function modifierWord(platform: GuiPlatform): string {
  return platform === "darwin" ? "Cmd" : "Ctrl";
}

// Grouped semantically and ordered general → navigate → act; within "navigate",
// by increasing scope (one step → ends → page → by name). Built per-render with
// the running platform's modifier word so the displayed accelerator matches the
// host OS rather than showing the combined "Cmd/Ctrl".
export function buildShortcuts(mod: string): ShortcutGroup[] {
  return [
    {
      title: "General",
      items: [
        { keys: `${mod}+N`, description: "Add a job" },
        { keys: `${mod}+Comma`, description: "Open Settings" },
        { keys: `${mod}+Slash`, description: "Show keyboard shortcuts" },
      ],
    },
    {
      title: "Move around the job list",
      items: [
        { keys: "Up/Down", description: "Select the previous / next job" },
        { keys: "Home/End", description: "Select the first / last job" },
        { keys: "PageUp/PageDown", description: "Jump up / down a page" },
        { keys: "Type a name", description: "Jump to a matching job" },
      ],
    },
    {
      title: "Act on the selected job",
      items: [
        { keys: `${mod}+Enter`, description: "Create the selected job's archive" },
        { keys: "Delete", description: "Remove the job from the queue" },
        { keys: "Escape", description: "Cancel a planning, queued, or running job" },
      ],
    },
  ];
}
