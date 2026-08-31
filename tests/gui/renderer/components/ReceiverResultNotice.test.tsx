// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ReceiverResultNotice } from "../../../../src/gui/renderer/src/components/ReceiverResultNotice";
import type { ReceiverResultSeverity } from "../../../../src/gui/renderer/src/externalDropBoundary";

afterEach(cleanup);

function renderSeverity(severity: ReceiverResultSeverity): void {
  render(
    <ReceiverResultNotice
      result={{
        message: `${severity} result`,
        severity,
        operationKey: severity,
      }}
      onDismiss={vi.fn()}
    />,
  );
}

describe("ReceiverResultNotice announcement urgency", () => {
  it("uses assertive alert semantics for an error", () => {
    renderSeverity("error");

    expect(screen.getByRole("alert").textContent).toContain("error result");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["warning", "information"] as const)(
    "keeps a %s result polite",
    (severity) => {
      renderSeverity(severity);

      expect(screen.getByRole("status").textContent).toContain(`${severity} result`);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});
