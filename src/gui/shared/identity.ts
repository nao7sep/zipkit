/**
 * What the app calls itself. Held here rather than read back from the packaging
 * metadata at runtime: Electron answers `app.getName()`/`app.getVersion()` about
 * the binary that is running, which is the app only when it is packaged.
 */

/** The display name, as the user should ever see it written. */
export const APP_NAME = "ZipKit";

/** package.json's version, injected by electron.vite.config.ts as a build define. */
declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;
