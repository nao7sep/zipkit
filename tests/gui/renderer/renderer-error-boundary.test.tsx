// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../../../src/gui/renderer/src/components/RendererErrorBoundary";

const HOSTILE = "EACCES /Users/nao/.zipkit/quarantine/internal-state.json";

function Broken(): React.JSX.Element { throw new Error(HOSTILE); }

describe("RendererErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps renderer diagnostics out of the recovery surface", () => {
    const reportError = vi.fn();
    Object.defineProperty(window, "zipkit", { configurable: true, value: { reportError } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<RendererErrorBoundary><Broken /></RendererErrorBoundary>);

    expect(screen.getByRole("alert").textContent).toContain("ZipKit could not keep this window open.");
    expect(screen.getByRole("alert").textContent).not.toContain(HOSTILE);
    expect(reportError).toHaveBeenCalledWith(
      "renderer stopped unexpectedly",
      expect.objectContaining({ message: HOSTILE }),
    );
  });
});
