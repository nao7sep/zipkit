/**
 * CLI wiring and exit codes: `0` success; `1` the plan is not writable (a
 * blocking finding, or an existing output without `--overwrite`); `2` usage
 * error. `create` builds archives; `extract` reads them (extraction and
 * validation). Commander's own errors map to a usage exit; help and version
 * exit cleanly. An interrupt maps to the conventional 130.
 */

import { Command } from "commander";
import { ZipKitError } from "../errors.js";
import { VERSION } from "../version.js";
import { installSigintHandler } from "./abort.js";
import { registerCreate } from "./create.js";
import { registerExtract } from "./extract.js";
import { emitError } from "./json.js";

function handleError(err: unknown): number {
  emitError(err);
  if (err instanceof ZipKitError) {
    if (err.errorType === "abort") return 130;
    if (err.errorType === "policy") return 2;
    // A missing input is the user naming a path that isn't there — a usage
    // error. Other scan failures (mid-walk I/O, permissions) are runtime
    // faults and keep the generic failure code.
    if (err.code === "scan.input-missing") return 2;
    if (err.errorType === "write" && err.code === "write.not-writable") return 1;
    // Naming an archive or destination that can't be opened is a usage error;
    // a malformed or unreadable archive is a runtime fault.
    if (err.code === "read.open-failed" || err.code === "read.no-dest") return 2;
  }
  return 1;
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const signal = installSigintHandler();
  let exitCode = 0;

  const program = new Command();
  program
    .name("zipkit")
    .description("Cross-platform ZIP archiver and portability linter/fixer; extracts and validates too")
    .version(VERSION)
    .showHelpAfterError()
    .exitOverride();

  const setExit = (code: number) => {
    exitCode = code;
  };
  registerCreate(program, signal, setExit);
  registerExtract(program, signal, setExit);

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    const commanderError = err as { code?: string; exitCode?: number };
    if (typeof commanderError.code === "string" && commanderError.code.startsWith("commander.")) {
      return commanderError.exitCode === 0 ? 0 : 2;
    }
    return handleError(err);
  }
}
