/**
 * The persisted pane layout: the user-adjustable widths of the side columns
 * (Jobs on the left, Progress on the right); the middle Archive column flexes to
 * fill the rest. This is GUI layout state — distinct from window position/size,
 * which is deliberately NOT persisted. Pure here (shared by the renderer's drag
 * logic and the main-process store); the file I/O lives in main/layout.ts.
 *
 * SINGLE SOURCE OF TRUTH FOR SIZING. The pane minimums declared here
 * (`LAYOUT_BOUNDS.*.min`, `ARCHIVE_MIN_WIDTH`) plus the fixed chrome sizes
 * (`SPLITTER_WIDTH`, `BODY_PADDING`, `HEADER_MIN_HEIGHT`, `BODY_MIN_HEIGHT`,
 * `STATUS_BAR_MIN_HEIGHT`) are the only place those numbers live. The window's
 * minimum size is DERIVED from them by `minWindowWidth`/`minWindowHeight` (used
 * by the main process) and the body grid's center track / splitter widths are
 * derived from them in the renderer — never a hand-typed window minimum that
 * could drift out of sync with the panes and silently truncate content.
 */

export interface PaneLayout {
  /** Width of the Jobs column, in CSS pixels. */
  jobsWidth: number;
  /** Width of the Progress column, in CSS pixels. */
  progressWidth: number;
}

/** Min/max for each user-resizable side column, so a drag (or a stale file)
 *  can't make a column unusably thin or starve the flexible middle column. */
export const LAYOUT_BOUNDS = {
  jobsWidth: { min: 200, max: 480 },
  progressWidth: { min: 240, max: 600 },
} as const;

/** Minimum width of the center Archive column. Unlike the side columns it has no
 *  persisted width (it flexes to fill), so without a real minimum a widened side
 *  column plus a shrunk window would squeeze it to invisibility — the primary
 *  pane the window-chrome convention warns about. It is the smallest width at
 *  which the Archive pane's content (the inputs, the options grid, the full
 *  output-path checkpoint) stays usable. */
export const ARCHIVE_MIN_WIDTH = 360;

/** Width of each inter-pane splitter track (matches the body grid's splitter
 *  columns in App.tsx). Two of them sit between the three panes. */
export const SPLITTER_WIDTH = 10;

/** Horizontal/vertical padding the body grid reserves on EACH side (matches the
 *  body padding in App.tsx). Counted on both sides toward the window minimum. */
export const BODY_PADDING = 10;

/** Fixed chrome heights, mirrored from the components so the derived window
 *  minimum reserves them: the header bar (AppHeader, minHeight 3rem worth at the
 *  app's 14px base ≈ 42px shown here as its rounded px), a usable body minimum,
 *  and the status bar (StatusBar, minHeight 1.75rem ≈ 28px). The status bar is a
 *  reserved placeholder whose content is a separate task, but its slot is fixed
 *  chrome and must be accounted for so it is never overlapped when the window
 *  shrinks. */
export const HEADER_MIN_HEIGHT = 50;
export const BODY_MIN_HEIGHT = 360;
export const STATUS_BAR_MIN_HEIGHT = 28;

export const DEFAULT_LAYOUT: PaneLayout = { jobsWidth: 288, progressWidth: 320 };

/**
 * The minimum window width, DERIVED from the pane minimums and the fixed chrome:
 * the two side-column minimums, the center pane's minimum, the two splitters, and
 * the body padding on both sides. Because the OS refuses to shrink the window
 * below this, no pane can be squeezed below its minimum.
 */
export function minWindowWidth(): number {
  return (
    LAYOUT_BOUNDS.jobsWidth.min +
    ARCHIVE_MIN_WIDTH +
    LAYOUT_BOUNDS.progressWidth.min +
    2 * SPLITTER_WIDTH +
    2 * BODY_PADDING
  );
}

/**
 * The minimum window height, DERIVED from the stacked regions: the header bar,
 * the body's own minimum, and the reserved status bar — so all three fixed-chrome
 * strips plus a usable body are always visible and the status bar is never
 * overlapped.
 */
export function minWindowHeight(): number {
  return HEADER_MIN_HEIGHT + BODY_MIN_HEIGHT + STATUS_BAR_MIN_HEIGHT;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Clamp a layout into the per-column bounds (defensive on load and on persist).
 * This is the persistence floor/ceiling — it has no notion of the live container
 * width, so the renderer additionally applies {@link clampLayoutToWidth} once it
 * has measured the body. Used by both the renderer and the main-process store.
 */
export function clampLayout(layout: PaneLayout): PaneLayout {
  return {
    jobsWidth: clamp(layout.jobsWidth, LAYOUT_BOUNDS.jobsWidth.min, LAYOUT_BOUNDS.jobsWidth.max),
    progressWidth: clamp(
      layout.progressWidth,
      LAYOUT_BOUNDS.progressWidth.min,
      LAYOUT_BOUNDS.progressWidth.max,
    ),
  };
}

/**
 * Width-aware clamp: in addition to the per-column bounds, guarantee the two side
 * columns together leave the center Archive pane at least its minimum. Given a
 * live body width, the side columns may occupy at most
 *   containerWidth − ARCHIVE_MIN_WIDTH − 2*SPLITTER_WIDTH − 2*BODY_PADDING
 * so a widened side pane can NEVER push the center pane below its minimum. Pure,
 * so it is unit-testable; called from the drag handlers, on window resize, and on
 * the persisted-layout load path.
 *
 * When the container is so narrow that even the bounds-clamped minimums don't fit
 * (below the derived window minimum, which the OS normally prevents but a test or
 * a transient measurement can hit), the columns are floored to their per-column
 * minimums — the OS minimum width is the real guarantee; this never returns a
 * negative or sub-minimum column.
 */
export function clampLayoutToWidth(layout: PaneLayout, containerWidth: number): PaneLayout {
  const base = clampLayout(layout);
  if (!Number.isFinite(containerWidth)) return base;

  // Room the two side columns may share, after reserving the center pane, the two
  // splitters, and the body padding.
  const sideBudget = containerWidth - ARCHIVE_MIN_WIDTH - 2 * SPLITTER_WIDTH - 2 * BODY_PADDING;

  // If even both minimums don't fit, hand back the minimums (the OS window
  // minimum is the real floor; don't go below a usable column).
  const minSum = LAYOUT_BOUNDS.jobsWidth.min + LAYOUT_BOUNDS.progressWidth.min;
  if (sideBudget <= minSum) {
    return { jobsWidth: LAYOUT_BOUNDS.jobsWidth.min, progressWidth: LAYOUT_BOUNDS.progressWidth.min };
  }

  if (base.jobsWidth + base.progressWidth <= sideBudget) return base;

  // The pair overflows the budget. Shrink Progress first (down to its minimum),
  // then Jobs, so the side the user did NOT just drag yields first and the center
  // pane keeps its minimum.
  let progressWidth = Math.max(
    LAYOUT_BOUNDS.progressWidth.min,
    sideBudget - base.jobsWidth,
  );
  let jobsWidth = base.jobsWidth;
  if (jobsWidth + progressWidth > sideBudget) {
    jobsWidth = Math.max(LAYOUT_BOUNDS.jobsWidth.min, sideBudget - progressWidth);
  }
  return { jobsWidth, progressWidth };
}
