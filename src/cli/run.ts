/**
 * CLI wiring and exit codes (output contract §8): `0` success; `1` the domain
 * verdict failed (not writable, a write fault, or an extract report not ok);
 * `2` usage error (bad flags, missing input, unopenable archive/dest); `130`
 * abort. `create` builds archives; `extract` reads them (extraction and
 * validation).
 *
 * The verb actions own the success envelope and fold operational faults into it
 * (contract D1). What reaches this layer is a pre-data fault — a plan/scan/spec
 * failure, or a usage error — that has no report to fold into. Under `--json`,
 * D5 still requires one envelope on stdout, so a pre-verb fault emits the
 * minimal envelope `{…, data:{findings:[the fault]}}` rather than an empty
 * stream; without `--json`, the human fault line + the usage exit is enough.
 */

import { Command } from "commander";
import { isUsageFault, ZipKitError } from "../errors.js";
import { buildReport } from "../report.js";
import type { Finding } from "../types.js";
import { VERSION } from "../version.js";
import { installSigintHandler } from "./abort.js";
import { registerCreate } from "./create.js";
import { registerExtract } from "./extract.js";
import { emitHumanError, emitReport, faultFinding, toFault } from "./json.js";

/** Map a thrown `ZipKitError` to its exit code. Usage faults (a malformed
 *  invocation — bad spec, unopenable input/archive, missing destination) are a
 *  `2`; everything else that reaches here is a runtime fault (`1`), and an
 *  abort is the conventional `130`. The usage set is owned by `isUsageFault`. */
function exitFor(err: unknown): number {
  if (err instanceof ZipKitError && err.errorType === "abort") return 130;
  if (isUsageFault(err)) return 2;
  return 1;
}

/** The verb the user named, for stamping the pre-verb envelope. */
function detectVerb(argv: string[]): "create" | "extract" | "unknown" {
  for (const arg of argv.slice(2)) {
    if (arg === "create" || arg === "extract") return arg;
    if (!arg.startsWith("-")) break;
  }
  return "unknown";
}

/** Whether `--json` was requested anywhere on the line. */
function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

/** Emit the pre-data fault: a human line + (under `--json`) the minimal one-
 *  finding envelope (D5), so a `--json` caller always parses one report. */
function emitPreVerbFault(err: unknown, argv: string[]): void {
  const fault = toFault(err, "");
  if (wantsJson(argv)) {
    const findings: Finding[] = [faultFinding(fault)];
    emitReport(buildReport(detectVerb(argv), { findings }));
  } else {
    emitHumanError(fault.code, fault.message);
  }
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
      // Help and version exit cleanly; a bad-flag/missing-arg usage error is a 2.
      // Commander already printed its own usage text to stderr; under `--json` we
      // still owe the caller one envelope on stdout (D5).
      if (commanderError.exitCode === 0) return 0;
      if (wantsJson(argv)) {
        const fault = toFault(err, "");
        emitReport(buildReport(detectVerb(argv), { findings: [faultFinding(fault)] }));
      }
      return 2;
    }
    emitPreVerbFault(err, argv);
    return exitFor(err);
  }
}
