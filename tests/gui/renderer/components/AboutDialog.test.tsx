// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ABOUT_COPYRIGHT,
  AboutDialog,
} from "../../../../src/gui/renderer/src/components/AboutDialog";

afterEach(cleanup);

describe("AboutDialog", () => {
  it("keeps the project's creation-year copyright line stable", () => {
    Object.defineProperty(window, "zipkit", {
      configurable: true,
      value: {
        appInfo: vi.fn(() => new Promise(() => {})),
        openExternal: vi.fn(),
      },
    });

    render(<AboutDialog onClose={() => {}} />);

    expect(ABOUT_COPYRIGHT).toBe("© 2026 Yoshinao Inoguchi · MIT License");
    expect(screen.getByText(ABOUT_COPYRIGHT)).toBeTruthy();
  });
});
