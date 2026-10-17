#!/usr/bin/env node
/** The `zipkit` executable: runs the command with the process's arguments and
 *  streams, and cancels it cleanly on Ctrl-C (a second Ctrl-C quits at once). */

import { run } from "./run.js";

const aborter = new AbortController();
process.once("SIGINT", () => {
  aborter.abort();
  process.once("SIGINT", () => process.exit(130));
});
process.exitCode = await run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, signal: aborter.signal });
