// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ReceiverResultNotice } from "../../../../src/gui/renderer/src/components/ReceiverResultNotice";
import type { ReceiverResultSeverity } from "../../../../src/gui/renderer/src/externalDropBoundary";
import { message } from "../../../../src/gui/shared/i18n/translate";
import type { MessageKey } from "../../../../src/gui/shared/i18n/catalogues";

afterEach(cleanup);

const TEXT: Record<ReceiverResultSeverity, MessageKey> = {
  error: "result.pickerFailed",
  warning: "inputs.locked",
  information: "result.alreadyInJob",
};

function renderSeverity(severity: ReceiverResultSeverity): void {
  render(
    <ReceiverResultNotice
      result={{
        message: message(TEXT[severity], { count: 1 }),
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

    expect(screen.getByRole("alert").textContent).toContain("The input picker could not be opened");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["warning", "information"] as const)(
    "keeps a %s result polite",
    (severity) => {
      renderSeverity(severity);

      expect(screen.getByRole("status").textContent).toContain(severity === "warning" ? "cannot be changed" : "already in this job");
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});
