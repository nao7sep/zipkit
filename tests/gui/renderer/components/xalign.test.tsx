// @vitest-environment jsdom
/**
 * Pins the per-item X alignment convention: the row/notice's own layout
 * (height, alignment, and the text's position within it) is left exactly as
 * it always was — never touched to make room for the X — and only the X
 * itself moves, via a `position: relative` paint-only offset, to land on the
 * first text line instead of a wrapped block's middle.
 *
 * - InputList's row keeps its original `alignItems: "center"`, so the offset
 *   must be measured off the path's actual rendered height at runtime
 *   (useDismissAlignOffset), since a wrapped path can be centered as a whole
 *   block OR sit flush at the top depending on how many lines it wraps to.
 *   jsdom does not lay out real text (no line boxes), so this pins the hook's
 *   *mechanism* (it reads a real lineHeight/height off the DOM and lands on
 *   `(lineHeight - blockHeight) / 2`) with a fake ResizeObserver and a
 *   measured-geometry stub, rather than a real multi-line render.
 * - ReceiverResultNotice, ShellNotice and JobListbox all keep
 *   `align-items: flex-start`, so their text is always flush on the row's
 *   top edge regardless of how many lines it wraps to — a constant, static
 *   `top: calc((line height - button height) / 2)` on the button suffices,
 *   no measurement needed.
 *
 * See scratchpad/redesign/xalign/zipkit for real-Chromium before/after
 * screenshots and measured offsets (all within 1px), including that row
 * height and text position are pixel-identical to HEAD.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

import { InputList } from "../../../../src/gui/renderer/src/components/InputList";
import { ReceiverResultNotice } from "../../../../src/gui/renderer/src/components/ReceiverResultNotice";
import { ShellNotice } from "../../../../src/gui/renderer/src/components/ShellNotice";
import { JobListbox } from "../../../../src/gui/renderer/src/components/JobListbox";
import { useDismissAlignOffset } from "../../../../src/gui/renderer/src/dismissAlign";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";
import { message } from "../../../../src/gui/shared/i18n/translate";

afterEach(cleanup);

class ResizeObserverStub {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

describe("per-item X alignment: first line, not the wrapped block's middle", () => {
  it("InputList's row and path are untouched (no alignment/padding change)", () => {
    const job: Job = {
      id: "job-1",
      inputs: ["/tmp/a.txt", "/tmp/b.txt"],
      entries: [
        { path: "/tmp/a.txt", kind: "file" },
        { path: "/tmp/b.txt", kind: "file" },
      ],
      options: DEFAULT_OPTIONS,
      intent: "save",
      state: "ready",
    };
    render(
      <InputList
        job={job}
        editable
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={async () => ({ operationKey: "noop", entryKey: "noop", result: null })}
        result={null}
        onResult={() => {}}
      />,
    );
    const row = screen.getAllByRole("listitem")[0]!;
    // Plain centering, exactly as HEAD: the row's height and the path's own
    // position come from this alone, unaffected by the X.
    expect(row.style.alignItems).toBe("center");
    const path = row.querySelector("span[title]") as HTMLElement;
    expect(path.style.paddingTop).toBe("");
    const kind = row.querySelector("span:not([title])") as HTMLElement;
    expect(kind.style.paddingTop).toBe("");
    // Only the button carries a (measured, not static) position nudge.
    const removeButton = row.querySelector("button.icon") as HTMLElement;
    expect(removeButton.style.position).toBe("relative");
  });

  it("useDismissAlignOffset lands on (line height - rendered height) / 2, off real DOM metrics", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const el = document.createElement("span");
    document.body.appendChild(el);
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ height: 60 } as DOMRect);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ lineHeight: "20px" } as CSSStyleDeclaration);

    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement }).current = el;
    const { result } = renderHook(() => useDismissAlignOffset(ref));

    // A block three lines tall (60px, 20px/line): offset is a NEGATIVE,
    // constant-per-render nudge, not something that scales the row.
    expect(result.current).toBe((20 - 60) / 2);

    vi.restoreAllMocks();
    document.body.removeChild(el);
  });

  it("ReceiverResultNotice keeps the notice's own layout untouched; only the dismiss button gets a static nudge", () => {
    render(
      <ReceiverResultNotice
        result={{ message: message("inputs.locked"), severity: "warning", operationKey: "x" }}
        onDismiss={vi.fn()}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice.className).toContain("receiver-result");
    // jsdom does not apply the app's external stylesheet, so the CSS mechanism
    // itself (not just this element's className) is pinned by reading it: the
    // row is flex-start (unchanged from HEAD) and the message span carries no
    // padding of its own (also unchanged) -- only the dismiss button moves,
    // by a constant amount independent of how many lines the message wraps
    // to, since flex-start keeps it flush at the row's top either way.
    const css = readFileSync(
      resolve(__dirname, "../../../../src/gui/renderer/src/index.css"),
      "utf8",
    );
    expect(css).toMatch(/\.receiver-result\s*\{[^}]*align-items:\s*flex-start;/);
    expect(css).not.toMatch(/\.receiver-result\s*>\s*span\s*\{/);
    expect(css).toMatch(
      /\.receiver-result \.receiver-result__dismiss\s*\{[^}]*top:\s*calc\(\(0\.8rem \* 1\.5 - var\(--control-h\)\) \/ 2\);/,
    );
  });

  it("ShellNotice keeps the row/message untouched; only the dismiss button gets a static nudge", () => {
    render(<ShellNotice message="layout.notSaved" closeLabel="layout.close" onDismiss={vi.fn()} />);
    const notice = screen.getByRole("alert");
    expect(notice.style.alignItems).toBe("flex-start");
    const message_ = notice.querySelector("span") as HTMLElement;
    expect(message_.style.paddingTop).toBe("");
    const dismiss = notice.querySelector("button.icon") as HTMLElement;
    expect(dismiss.style.position).toBe("relative");
    expect(dismiss.style.top).toBe("calc((0.85rem * 1.5 - var(--control-h)) / 2)");
  });

  it("JobListbox keeps the row untouched; only the row action gets a static, position-based nudge", () => {
    const job: Job = {
      id: "job-1",
      inputs: ["/tmp/a.txt"],
      options: DEFAULT_OPTIONS,
      intent: "save",
      state: "ready",
    };
    render(
      <JobListbox
        jobs={[job]}
        selectedId={null}
        pullFocusId={null}
        onFocusPulled={() => {}}
        onSelect={() => {}}
        onRemove={() => {}}
        onCancel={() => {}}
      />,
    );
    const row = screen.getByRole("option");
    expect(getComputedStyle(row).alignItems).toBe("flex-start");
    const removeButton = screen.getByRole("button", { name: /remove/i });
    // position: relative (not margin-top), so the button's normal height
    // still counts in full toward the row's own sizing.
    expect(removeButton.style.marginTop).toBe("");
    expect(removeButton.style.position).toBe("relative");
    expect(removeButton.style.top).toBe("calc((14px * 1.5 - var(--control-h)) / 2)");
  });
});
