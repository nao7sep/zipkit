/**
 * The persisted pane layout: the user-adjustable widths of the side columns
 * (Jobs on the left, Progress on the right); the middle Archive column flexes to
 * fill the rest. This is GUI layout state — distinct from window position/size,
 * which is deliberately NOT persisted. Pure here (shared by the renderer's drag
 * logic and the main-process store); the file I/O lives in main/layout.ts.
 */

export interface PaneLayout {
  /** Width of the Jobs column, in CSS pixels. */
  jobsWidth: number;
  /** Width of the Progress column, in CSS pixels. */
  progressWidth: number;
}

/** Min/max for each column, so a drag (or a stale file) can't make a column
 *  unusably thin or starve the flexible middle column. */
export const LAYOUT_BOUNDS = {
  jobsWidth: { min: 200, max: 480 },
  progressWidth: { min: 240, max: 600 },
} as const;

export const DEFAULT_LAYOUT: PaneLayout = { jobsWidth: 288, progressWidth: 320 };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Clamp a layout into the allowed bounds (defensive on load and during drag). */
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
