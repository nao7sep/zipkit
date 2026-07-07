/**
 * The Electron main process entry. It resolves zipkit's storage root *first* —
 * stopping with a clear error if `ZIPKIT_HOME` is set but unusable, the startup
 * error the storage convention requires rather than a silent fallback — and only
 * then loads the rest of the main process, which derives its log and queue paths
 * from that root. The bootstrap is split out (`./bootstrap`) and pulled in by a
 * dynamic import so the root is validated before any module that reads it runs.
 */

import { app } from "electron";
import { storageRoot, StorageRootError } from "../../sdk/storage.js";
import { notifyStartupFailure } from "./startup-dialog.js";

try {
  // Resolve once at this defined startup point, after the environment is known
  // (not frozen into a module constant at import time). A bad ZIPKIT_HOME throws
  // here, where we can report it and quit cleanly.
  storageRoot();
} catch (err) {
  const message =
    err instanceof StorageRootError
      ? err.message
      : `failed to resolve the storage root: ${err instanceof Error ? err.message : String(err)}`;
  // Surface to both the terminal (dev/launcher) and a dialog (double-clicked app),
  // then stop — the app cannot decide where to keep its files.
  process.stderr.write(`zipkit: ${message}\n`);
  app.whenReady().then(() => {
    notifyStartupFailure(message);
    app.exit(1);
  });
  // Prevent the heavy bootstrap (which would re-resolve the root) from loading.
  throw new StorageRootError(message);
}

// Dynamically imported so its transitive imports — which resolve the storage
// root eagerly — run only after the validation above has passed.
await import("./bootstrap.js");
