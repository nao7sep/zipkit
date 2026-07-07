/**
 * Pure navigation math for a vertical listbox (no React, no DOM) — the keyboard
 * model of the composite-control conventions, isolated so it can be unit-tested
 * directly. Indices in, indices out; the component owns focus, scroll, and roles.
 */

/** New active index for a vertical listbox, stop-at-ends. `current` may be -1
 *  (nothing active yet). Returns null when the key is not a navigation key or the
 *  list is empty. */
export function navIndex(current: number, count: number, key: string, page = 10): number | null {
  if (count === 0) return null;
  const clamp = (i: number): number => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case "ArrowDown":
      return clamp(current + 1);
    case "ArrowUp":
      return clamp(current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return clamp(current + page);
    case "PageUp":
      return clamp(current - page);
    default:
      return null;
  }
}

/** Index of the next label that starts with `query` (case-insensitive), searching
 *  forward from `current` and stopping at the end — no wrap, matching the
 *  stop-at-ends behavior of the arrow keys (composite-control: one end-of-axis
 *  behavior). null when nothing matches ahead or the query is empty. */
export function typeaheadIndex(labels: string[], current: number, query: string): number | null {
  if (query === "" || labels.length === 0) return null;
  const q = query.toLowerCase();
  const start = current < 0 ? 0 : current + 1;
  for (let i = start; i < labels.length; i++) {
    if (labels[i]!.toLowerCase().startsWith(q)) return i;
  }
  return null;
}

/** After removing the item at `removedIndex` from a list that had `count` items,
 *  the index (into the NEW, shorter list) to select next — general recovery
 *  policy next → previous → empty. null when the list becomes empty. */
export function recoverIndex(removedIndex: number, count: number): number | null {
  if (count <= 1) return null; // was the only item
  if (removedIndex < count - 1) return removedIndex; // the next item slides into place
  return removedIndex - 1; // removed the last -> the previous
}
