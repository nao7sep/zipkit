/** Prepare and configure every Electron path before readiness and instance locking. */
import { app } from "electron";
import { electronStoragePaths, storageRoot } from "./storage.js";
import { prepareStorage } from "./storage-startup.js";

let storageReady = false;
try {
  const root = storageRoot();
  // Electron waits for this entry's top-level await before emitting ready.
  await prepareStorage(root);
  const paths = electronStoragePaths(root);
  app.setPath("userData", paths.userData);
  app.setPath("sessionData", paths.sessionData);
  app.setPath("crashDumps", paths.crashDumps);
  app.setAppLogsPath(paths.logs);
  storageReady = true;
} catch (err) {
  process.stderr.write(`zipkit: storage preparation failed: ${err instanceof Error ? err.message : String(err)}\n`);
  // The saved choice is unavailable, so the computer's language speaks here.
  void app.whenReady().then(async () => {
    const { notifyStartupFailure } = await import("./startup-dialog.js");
    const { settledTranslator } = await import("./i18n.js");
    const { installAppMenu } = await import("./menu.js");
    installAppMenu(await settledTranslator());
    await notifyStartupFailure("startup.dataFolder");
    app.exit(1);
  }).catch((dialogError) => {
    process.stderr.write(`zipkit: startup failure dialog could not open: ${String(dialogError)}\n`);
    app.exit(1);
  });
}

if (storageReady) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else await import("./bootstrap.js");
}
