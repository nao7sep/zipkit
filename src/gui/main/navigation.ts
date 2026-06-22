/**
 * Navigation guard for the renderer window. Defense-in-depth alongside the CSP
 * and context isolation: the SPA never navigates itself and opens no child
 * windows, so any `will-navigate` to a foreign origin or any `window.open` is the
 * symptom of injected markup or a stray link, not a feature. We deny both rather
 * than let the renderer process leave its own origin.
 *
 * Pure and exported so the decisions are unit-tested headlessly; the runtime
 * wiring (`setWindowOpenHandler` / `webContents.on("will-navigate", …)`) lives in
 * `createWindow`, which can't be exercised without a real BrowserWindow.
 */

/**
 * Deny every renderer-initiated window open. The app routes the one outbound URL
 * (the GitHub link) through the `openExternal` IPC bridge to the OS browser, so
 * nothing legitimate needs `window.open` / `target="_blank"`; denying keeps a new
 * Electron window from ever being spawned from renderer content.
 */
export function windowOpenHandler(): { action: "deny" } {
  return { action: "deny" };
}

/**
 * Whether a navigation target shares the renderer's own loaded origin. The guard
 * allows same-origin navigation (in-app routing / reloads) and prevents anything
 * else. A target that fails to parse is treated as cross-origin (not same-origin),
 * so malformed URLs are blocked, never waved through.
 */
export function isSameOrigin(appUrl: string, targetUrl: string): boolean {
  try {
    return new URL(targetUrl).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
