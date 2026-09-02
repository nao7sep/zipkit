// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ABOUT_COPYRIGHT,
  AboutDialog,
} from "../../../../src/gui/renderer/src/components/AboutDialog";

afterEach(cleanup);

describe("AboutDialog", () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

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

  it("retains authored About load and link failures without exposing diagnostics", async () => {
    const appInfo = vi.fn()
      .mockRejectedValueOnce(new Error("EACCES /private/tmp/ZIPKIT_ABOUT_SENTINEL"))
      .mockResolvedValueOnce({ name: "ZipKit", version: "0.1.0" });
    const openExternal = vi.fn(async () => { throw new Error("browser ZIPKIT_LINK_SENTINEL"); });
    const reportError = vi.fn();
    Object.defineProperty(window, "zipkit", { configurable: true, value: { appInfo, openExternal, reportError } });

    render(<AboutDialog onClose={() => {}} />);
    const loadAlert = await screen.findByRole("alert");
    expect(loadAlert.textContent).toContain("App information could not be loaded");
    expect(loadAlert.textContent).not.toContain("ZIPKIT_ABOUT_SENTINEL");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Version 0.1.0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    const linkAlert = await screen.findByRole("alert");
    expect(linkAlert.textContent).toContain("could not be opened in your browser");
    expect(linkAlert.textContent).not.toContain("ZIPKIT_LINK_SENTINEL");
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("owns each link independently and ignores an older settlement", async () => {
    const firstRepository = deferred<void>();
    const latestRepository = deferred<void>();
    const issues = deferred<void>();
    const openExternal = vi.fn()
      .mockReturnValueOnce(firstRepository.promise)
      .mockReturnValueOnce(latestRepository.promise)
      .mockReturnValueOnce(issues.promise);
    const reportError = vi.fn();
    Object.defineProperty(window, "zipkit", { configurable: true, value: {
      appInfo: vi.fn(async () => ({ name: "ZipKit", version: "0.1.0" })),
      openExternal,
      reportError,
    } });
    render(<AboutDialog onClose={() => {}} />);
    const repository = await screen.findByRole("button", { name: "Repository" });
    const issuesButton = screen.getByRole("button", { name: "Issues" });

    fireEvent.click(repository);
    fireEvent.click(repository);
    fireEvent.click(issuesButton);
    latestRepository.resolve();
    firstRepository.reject(new Error("EACCES /private/tmp/STALE-ZIPKIT-REPOSITORY"));
    issues.reject(new Error("EACCES /private/tmp/ZIPKIT-ISSUES"));

    expect(await screen.findByText(/issues link could not be opened/)).toBeTruthy();
    expect(screen.queryByText(/repository link could not be opened/)).toBeNull();
    expect(document.body.textContent).not.toContain("STALE-ZIPKIT-REPOSITORY");
    expect(reportError).toHaveBeenCalledTimes(2);
  });
});
