/**
 * The keyboard-shortcut catalog: one ordered, grouped source of truth, so the
 * Shortcuts dialog and the app-level key handler can never describe a binding
 * that does not exist. App-level accelerators (Settings, Shortcuts) are handled
 * in App.tsx; the queue/list keys are display-only here — they are owned by the
 * JobListbox per the composite-control conventions. Pure data, no React/DOM.
 */

export interface ShortcutItem {
  /** The key combination, spelled out (no glyphs): "Cmd/Ctrl+,", "Up / Down". */
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "App",
    items: [
      { keys: "Cmd/Ctrl+,", description: "Open Settings" },
      { keys: "Cmd/Ctrl+/", description: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Job queue",
    items: [
      { keys: "Up / Down", description: "Move the selection" },
      { keys: "Home / End", description: "First / last job" },
      { keys: "PageUp / PageDown", description: "Move by a page" },
      { keys: "Type a name", description: "Jump to a matching job" },
      { keys: "Delete", description: "Remove the selected job" },
      { keys: "Esc", description: "Cancel a planning or running job" },
    ],
  },
];
