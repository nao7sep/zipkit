/**
 * CLI wiring and exit codes. The full scheme: `0` success; `1` a negative domain
 * verdict (a non-writable plan, or an extract report that is not ok — the verb
 * ran cleanly but its result is "no"); `2` usage error (bad flags, missing
 * input, unopenable archive/dest); `3`/`4`/`5` a runtime fault by domain (scan /
 * write / read); `130` abort. The single `exitCodeFor` classifier (errors.ts)
 * owns the thrown-fault half so this layer and the verb folds never disagree.
 *
 * The verb actions own the success envelope and fold operational faults into it.
 * What reaches this layer is a pre-data fault — a plan/scan/spec failure, or a
 * usage error — that has no report to fold into. Under `--json` one envelope is
 * still owed on stdout, so a pre-verb fault emits the minimal envelope
 * `{ …, data: { findings: [the fault] } }` rather than an empty stream; without
 * `--json`, the human fault line plus the exit code is enough.
 */

import { Command } from "commander";
import { exitCodeFor } from "../errors.js";
import { buildReport } from "../report.js";
import type { Finding } from "../types.js";
import { VERSION } from "../version.js";
import { installSigintHandler } from "./abort.js";
import { registerCreate } from "./create.js";
import { registerExtract } from "./extract.js";
import { emitHumanError, emitReport, faultFinding, toFault } from "./json.js";

/** The verb the user named, matched against the registered command names (so the
 *  verb set lives in exactly one place — the registrations), for stamping the
 *  pre-verb envelope. */
function detectVerb(argv: string[], known: ReadonlySet<string>): string {
  for (const arg of argv.slice(2)) {
    if (known.has(arg)) return arg;
    if (!arg.startsWith("-")) break;
  }
  return "unknown";
}

/** Whether `--json` was requested anywhere on the line. */
function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

/** Emit the pre-data fault: a human line + (under `--json`) the minimal one-
 *  finding envelope, so a `--json` caller always parses one report. */
function emitPreVerbFault(err: unknown, argv: string[], verbs: ReadonlySet<string>): void {
  const fault = toFault(err, "");
  if (wantsJson(argv)) {
    const findings: Finding[] = [faultFinding(fault)];
    emitReport(buildReport(detectVerb(argv, verbs), { findings }));
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
  const verbs = new Set(program.commands.map((c) => c.name()));

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    const commanderError = err as { code?: string; exitCode?: number };
    if (typeof commanderError.code === "string" && commanderError.code.startsWith("commander.")) {
      // Help and version exit cleanly; a bad-flag/missing-arg usage error is a 2.
      // Commander already printed its own usage text to stderr; under `--json` we
      // still owe the caller one envelope on stdout.
      if (commanderError.exitCode === 0) return 0;
      if (wantsJson(argv)) {
        const fault = toFault(err, "");
        emitReport(buildReport(detectVerb(argv, verbs), { findings: [faultFinding(fault)] }));
      }
      return 2;
    }
    emitPreVerbFault(err, argv, verbs);
    return exitCodeFor(err);
  }
}
