// @vitest-environment jsdom
/**
 * Pins the per-item X alignment convention: the row/notice's own layout
 * (height, alignment, and the text's position within it) is left exactly as
 * it always was — never touched to make room for the X — and only the X
 * itself moves, via a `position: relative` paint-only offset, to land on the
 * first text line instead of a wrapped block's middle.
 *
 * - InputList's path is one line, so plain centering already puts its X on
 *   that line and the X carries no nudge.
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { InputList } from "../../../../src/gui/renderer/src/components/InputList";
import { ReceiverResultNotice } from "../../../../src/gui/renderer/src/components/ReceiverResultNotice";
import { ShellNotice } from "../../../../src/gui/renderer/src/components/ShellNotice";
import { JobListbox } from "../../../../src/gui/renderer/src/components/JobListbox";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";
import { message } from "../../../../src/gui/shared/i18n/translate";
import { SAVE } from "../../../helpers/intents.js";

afterEach(cleanup);


describe("per-item X alignment: first line, not the wrapped block's middle", () => {
  it("InputList centres its one-line path and its X on the row", () => {
    const job: Job = {
      id: "job-1",
      inputs: ["/tmp/a.txt", "/tmp/b.txt"],
      entries: [
        { path: "/tmp/a.txt", kind: "file" },
        { path: "/tmp/b.txt", kind: "file" },
      ],
      options: DEFAULT_OPTIONS,
      intent: SAVE,
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
    const kind = row.querySelector(":scope > span:not([title])") as HTMLElement;
    expect(kind.style.paddingTop).toBe("");
    // The Inputs title starts where each row's kind does.
    const title = screen.getByText("Inputs");
    expect(title.style.paddingLeft).toBe(row.style.paddingLeft);
    expect(row.style.paddingLeft).not.toBe("");
    // The path never wraps, so the X needs no nudge of its own.
    const removeButton = row.querySelector("button.icon") as HTMLElement;
    expect(removeButton.style.position).toBe("");
    // A row's own action is the compact role, so the rows sit close as one list.
    expect(removeButton.classList.contains("compact")).toBe(true);
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
    render(<ShellNotice message="queue.notSaved" closeLabel="queue.notSavedClose" onDismiss={vi.fn()} />);
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
      intent: SAVE,
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
