/**
 * CLI wiring and exit codes. `0` success; `1` a negative domain verdict (a
 * non-writable plan, or an extract report that is not ok — the verb ran cleanly
 * but its result is "no"); `2` usage error (bad flags, a missing input, an
 * unopenable archive/dest); `3`/`4`/`5` a runtime fault by domain (scan / write
 * / read); `130` abort. The single `exitCodeFor` classifier (errors.ts) maps
 * every thrown fault, and one top-level catch renders it on stderr — stdout is
 * the result channel and stays empty on failure.
 *
 * Verb actions own the success path: they emit their typed result to stdout and
 * set the verdict exit code. They do not catch operational faults; those
 * propagate here, are rendered on stderr by `emitError`, and mapped to an exit
 * code. A cancellation is a normal outcome with its own code (130), not an error.
 */

import { Command } from "commander";
import { exitCodeFor } from "../sdk/errors.js";
import { VERSION } from "../sdk/version.js";
import { installSigintHandler } from "./abort.js";
import { registerCreate } from "./create.js";
import { registerExtract } from "./extract.js";
import { emitError } from "./output.js";

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
    const e = err as { code?: string; errorType?: string; exitCode?: number };
    // Commander's own errors — a bad flag, a missing argument, or `--help` /
    // `--version`. Commander has already written its text to stderr, so this
    // layer only maps the exit code (help/version exit cleanly as 0).
    if (typeof e.code === "string" && e.code.startsWith("commander.")) {
      return e.exitCode === 0 ? 0 : 2;
    }
    // A cancellation is a normal outcome, not a rendered error.
    if (e.errorType === "abort") return 130;
    emitError(err);
    return exitCodeFor(err);
  }
}
