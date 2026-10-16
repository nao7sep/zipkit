/**
 * The one SDK host for the app, in an Electron utility process (./sdk-host).
 * The built app runs electron-vite's `sdk-host-entry.js` beside this chunk.
 */

import { utilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import { createSdkClient } from "./sdk-client.js";
import type { HostReply } from "./sdk-host.js";

export const sdk = createSdkClient(() => {
  const child = utilityProcess.fork(fileURLToPath(new URL("./sdk-host-entry.js", import.meta.url)), [], {
    serviceName: "ZipKit Archiver",
  });
  return {
    postMessage: (request) => child.postMessage(request),
    onMessage: (listener) => child.on("message", (reply: HostReply) => listener(reply)),
    onExit: (listener) => child.on("exit", listener),
    kill: () => { child.kill(); },
  };
});
