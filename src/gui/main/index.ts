/**
 * The Electron main process entry. It resolves zipkit's storage root *first* —
 * stopping with a clear error if `ZIPKIT_HOME` is set but unusable, the startup
 * error the storage convention requires rather than a silent fallback — and only
 * then loads the rest of the main process, which derives its log and queue paths
 * from that root. The bootstrap is split out (`./bootstrap`) and pulled in by a
 * dynamic import so the root is validated before any module that reads it runs.
 */

import { app } from "electron";

// Own every managed store and queue from one OS-enforced app instance. Acquire
// this before importing storage/bootstrap modules so a second process never
// reads, plans, or writes shared durable state.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const { storageRoot, StorageRootError } = await import("../../sdk/storage.js");
  try {
    storageRoot();
  } catch (err) {
    const message =
      err instanceof StorageRootError
        ? err.message
        : `failed to resolve the storage root: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`zipkit: ${message}\n`);
    app.whenReady().then(async () => {
      const { notifyStartupFailure } = await import("./startup-dialog.js");
      notifyStartupFailure(message);
      app.exit(1);
    });
    throw new StorageRootError(message);
  }

  // Transitive imports that resolve the storage root run only after validation.
  await import("./bootstrap.js");
}
