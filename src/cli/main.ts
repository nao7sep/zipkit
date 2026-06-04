/**
 * The CLI entry point. `bin/zipkit.js` imports the built form of this module.
 * It runs the program, maps the resolved exit code onto the process, and
 * guards against an unexpected throw escaping the top level.
 */

import { runCli } from "./run.js";

async function main(): Promise<void> {
  const code = await runCli(process.argv);
  if (code !== 0) process.exitCode = code;
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`,
  );
  process.exitCode = 1;
});
