/**
 * The utility process entry: serves the SDK host (./sdk-host) over Electron's
 * parent port. Main starts it with `utilityProcess.fork` (./sdk-process).
 */

import { createSdkHost, type HostRequest } from "./sdk-host.js";

const port = process.parentPort;
const host = createSdkHost((reply) => port.postMessage(reply));
port.on("message", (event: { data: HostRequest }) => host.handle(event.data));
