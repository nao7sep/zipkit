/**
 * URL guard for the `openExternal` bridge. The renderer may ask the main process
 * to hand a URL to the OS browser; only ever pass it an http(s) link, never a
 * `file://`, `javascript:`, or app-scheme URL. Pure and total — malformed input
 * is simply not an http URL.
 */

export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
