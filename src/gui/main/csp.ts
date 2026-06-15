/**
 * Production Content-Security-Policy for the renderer, stamped on as a response
 * header in the main process. Defense-in-depth on top of context isolation: even
 * if markup were ever injected, the policy bounds what it could load or run.
 *
 * Gated on the production-renderer signal — the dev-server URL being absent —
 * NOT app.isPackaged, so an unpackaged-but-production launch (run-built /
 * rebuild via electron-vite preview) still gets the strict policy. The dev path
 * sets no CSP at all, leaving electron-vite's HMR (inline preamble, eval, ws)
 * untouched.
 *
 * The policy is deliberately tight, justified per directive by the actual
 * renderer (a React SPA whose every input/output crosses the `window.zipkit`
 * IPC bridge — it makes no network requests and loads no images of its own):
 *   default-src 'self'      — lock the baseline to the app bundle.
 *   script-src 'self'       — the built index.html has no inline <script>; the
 *                             one script is an external module. No eval / Function
 *                             / WebAssembly / Worker anywhere, so no 'unsafe-eval'.
 *   style-src 'self' 'unsafe-inline'
 *                           — REQUIRED: React components set inline `style={...}`
 *                             props throughout (App/ModalShell/JobListbox/…),
 *                             which render as inline style attributes. The bundled
 *                             stylesheet is external ('self'); 'unsafe-inline' is
 *                             only for those style attributes, not scripts.
 *   img-src 'self'          — the renderer loads no images: no <img>, no
 *                             data:/blob: image URIs, no url() in the built CSS.
 *                             Tightened past the data:/blob: baseline so any image
 *                             added later surfaces as a violation rather than
 *                             slipping through.
 *   font-src 'self'         — no @font-face / web fonts; system fonts only.
 *   connect-src 'self'      — no fetch / XHR / WebSocket / EventSource; all I/O
 *                             goes through IPC.
 *   object-src 'none'       — no plugins / <object> / <embed>.
 *   base-uri 'self'         — pin <base> to the app origin.
 *   frame-ancestors 'none'  — the document is never framed.
 *   frame-src 'none'        — the SPA embeds no frames.
 */

import { session } from "electron";

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
].join("; ");

/**
 * Stamp the production CSP onto a response-header set without disturbing the
 * headers already present. Pure and exported so the exact policy is unit-tested
 * (the runtime onHeadersReceived path can't be exercised headlessly).
 */
export function withContentSecurityPolicy(
  responseHeaders: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return {
    ...(responseHeaders ?? {}),
    "Content-Security-Policy": [PRODUCTION_CSP],
  };
}

/**
 * Register the production CSP on the default session. Called only on the
 * production path (dev-server URL absent), so the dev build keeps HMR working.
 */
export function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withContentSecurityPolicy(details.responseHeaders) });
  });
}
