/**
 * The keyboard-shortcut catalog: one ordered, grouped source of truth, so the
 * Shortcuts dialog and the app-level key handler can never describe a binding
 * that does not exist. The app-level accelerators (Add a job, Create the selected
 * job's archive, Settings, Shortcuts — all Cmd/Ctrl combos) are handled in
 * App.tsx; the plain queue/list keys are display-only here — they are owned by the
 * JobListbox per the composite-control conventions. Pure data, no React/DOM.
 */

export interface ShortcutItem {
  /** The key combination, spelled out — names not glyphs, and symbol keys as words
   *  ("Cmd/Ctrl+Comma", not "Cmd/Ctrl+,"). "/" is only an "either key" separator. */
  keys: string;
  description: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

// Grouped semantically and ordered general → navigate → act; within "navigate",
// by increasing scope (one step → ends → page → by name).
export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: "Cmd/Ctrl+N", description: "Add a job" },
      { keys: "Cmd/Ctrl+Comma", description: "Open Settings" },
      { keys: "Cmd/Ctrl+Slash", description: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Move around the job list",
    items: [
      { keys: "Up / Down", description: "Select the previous / next job" },
      { keys: "Home / End", description: "Select the first / last job" },
      { keys: "Page Up / Page Down", description: "Jump up / down a page" },
      { keys: "Type a name", description: "Jump to a matching job" },
    ],
  },
  {
    title: "Act on the selected job",
    items: [
      { keys: "Cmd/Ctrl+Enter", description: "Create the selected job's archive" },
      { keys: "Delete", description: "Remove the job from the queue" },
      { keys: "Escape", description: "Cancel a planning, queued, or running job" },
    ],
  },
];
