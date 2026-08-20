import type { ReactElement } from "react";

/**
 * The app's icons: inline SVG drawn with `currentColor`, so they take the colour
 * of the control they sit in. They replace typed glyphs (☰, ✕), whose strokes
 * render with uneven weight across fonts and at odd sizes against surrounding
 * text. Each is decorative (`aria-hidden`); the owning control carries the name.
 *
 * Shared here rather than kept beside one caller, so a second use cannot quietly
 * fork into a second drawing of the same mark.
 */

/** The remove/close mark, used by the job list and the input list. */
export function CloseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" style={{ display: "inline-block" }}>
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** The app menu trigger. */
export function HamburgerIcon(): ReactElement {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false" style={{ display: "inline-block" }}>
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
