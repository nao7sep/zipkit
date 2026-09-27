/**
 * The per-item convention for a close/dismiss/remove X: it sits on the
 * item's FIRST text line, never the middle of a wrapped block, and getting
 * there never resizes anything (the row's height and the text's own
 * position stay exactly what they would be without the X at all).
 *
 * A one-line message already lands the X in the right place for free: in a
 * flex row with the default `align-items: center`, both the text and the
 * (taller, fixed-height) button are centered as whole boxes, and with only
 * one line the text's box IS its first line, so their centers coincide.
 * Once the text wraps, the text's own box grows past the button's height,
 * and centering the button against that whole box drifts it toward the
 * block's middle instead of the first line. Fixing that without touching
 * the text (which would grow its box, and the row along with it) or the
 * row's own alignment (which would move the text) means moving the button
 * alone, via `position: relative` — a paint-only offset that keeps
 * contributing the button's full, normal height to the row's layout, so
 * nothing grows or shrinks to make room for it.
 *
 * The needed offset is `(one line's height - the text's actual rendered
 * height) / 2`: zero when the text is one line (its own height equals one
 * line's height), and a fixed amount otherwise, however many lines it
 * wrapped to. That depends on real layout (content, width, font, locale),
 * so it's measured off the DOM (via ResizeObserver on the text element)
 * rather than assumed from CSS.
 */

import { useLayoutEffect, useState, type RefObject } from "react";

export function useDismissAlignOffset(textRef: RefObject<HTMLElement | null>): number {
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;

    const recompute = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      const blockHeight = el.getBoundingClientRect().height;
      if (!Number.isFinite(lineHeight) || blockHeight <= 0) {
        setOffset(0);
        return;
      }
      setOffset((lineHeight - blockHeight) / 2);
    };

    recompute();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [textRef]);

  return offset;
}
