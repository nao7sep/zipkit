/**
 * The `extract` subcommand. One verb covers extraction and validation: with a
 * destination it writes verified entries; with `--dry-run` it writes nothing and
 * only reports (a pure integrity test, the `unzip -t` shape). `--check-metadata`
 * adds manifest reconciliation and SHA verification. CRC-32 is always checked.
 * The exit code is 0 when the report is `ok`, else 1, so it scripts cleanly.
 */

import type { Command } from "commander";
import { ZipKit } from "../zipkit.js";
import { isUsageFault, ZipKitError } from "../errors.js";
import { globExclude, regexExclude } from "../filter/rules.js";
import { buildReport } from "../report.js";
import type { ExtractData, ExtractSpec, FilterRule, ZipKitOptions } from "../types.js";
import { parseChunkSize } from "./create.js";
import {
  emitErrorEvent,
  emitHumanError,
  emitReport,
  faultFinding,
  toFault,
  writeReportFile,
} from "./json.js";
import { createConsoleProgress, createJsonlProgress, renderExtractData } from "./render.js";

interface ExtractOpts {
  dryRun?: boolean;
  overwrite?: boolean;
  checkMetadata?: boolean;
  metadataName?: string;
  timestamps?: boolean; // commander's --no-timestamps sets this false
  timezone?: string;
  onUnsafe?: "skip" | "abort";
  symlinks?: "restore" | "skip";
  quiet?: boolean;
  verbose?: boolean;
  concurrency?: string;
  chunkSize?: string;
  json?: boolean;
  jsonOut?: string;
}

/** A skeleton extract payload carrying only an operational fault — used when the
 *  read throws before any per-entry report exists, so the report invariant still
 *  holds (one envelope, with the fault as its SSOT finding). */
function faultData(spec: ExtractSpec, fault: ReturnType<typeof toFault>): ExtractData {
  return {
    archive: spec.archive,
    dest: spec.dryRun ? null : spec.dest ?? null,
    dryRun: spec.dryRun === true,
    wrote: false,
    reportOk: false,
    manifest: null,
    summary: { total: 0, written: 0, skipped: 0, crcFailed: 0, shaMismatched: 0 },
    entries: [],
    missing: [],
    extra: [],
    findings: [faultFinding(fault)],
  };
}

export function registerExtract(
  program: Command,
  signal: AbortSignal,
  setExitCode: (code: number) => void,
): void {
  const excludes: FilterRule[] = [];
  const addGlob = (pattern: string) => {
    excludes.push(globExclude(pattern));
    return pattern;
  };
  const addRegex = (pattern: string) => {
    excludes.push(regexExclude(pattern));
    return pattern;
  };

  const cmd = program
    .command("extract")
    .description("Extract or validate a ZIP archive")
    .argument("<archive>", "the .zip file to read")
    .argument("[dest]", "output directory (omit with --dry-run to validate only)");

  cmd.option("--dry-run", "validate only: verify CRC and write nothing");
  cmd.option("--overwrite", "overwrite existing files at the destination");
  cmd.option("--check-metadata", "reconcile entries against the manifest and verify SHA-256");
  cmd.option("--metadata-name <name>", "manifest entry name inside the archive (default _metadata.json)");
  cmd.option("--no-timestamps", "do not restore modification/access times");
  cmd.option("--timezone <iana>", "zone for the DOS field when an entry has no UTC time extra");
  cmd.option("--on-unsafe <skip|abort>", "handling of paths that escape the destination (default skip)");
  cmd.option("--symlinks <restore|skip>", "symlink handling (default restore)");
  cmd.option("--exclude <pattern>", "exclude glob, not written (repeatable); trailing slash = directory", addGlob);
  cmd.option("--exclude-regex <pattern>", "exclude regex, not written (repeatable)", addRegex);
  cmd.option("--quiet", "suppress console progress");
  cmd.option("--verbose", "include per-entry detail in console progress");
  cmd.option(
    "--concurrency <n>",
    "maximum entries extracted in parallel (default: available CPUs, bounded 4–16)",
  );
  cmd.option(
    "--chunk-size <size>",
    "streamed-I/O chunk size in bytes; accepts a k/m suffix (default 64k)",
  );
  cmd.option("--json", "emit the report envelope as pretty JSON on stdout, progress as JSONL on stderr");
  cmd.option("--json-out <path>", "also write the pretty report envelope to a file");

  cmd.action(async (archive: string, dest: string | undefined, opts: ExtractOpts) => {
    const zkOptions: ZipKitOptions = {};
    // `--json` converts progress to prefixed JSONL on stderr; without it, human
    // phase lines. `--quiet` silences either.
    if (!opts.quiet) {
      zkOptions.logger = opts.json
        ? createJsonlProgress(opts.verbose === true)
        : createConsoleProgress(opts.verbose === true);
    }
    if (opts.concurrency !== undefined) {
      const n = Number.parseInt(opts.concurrency, 10);
      if (Number.isFinite(n) && n > 0) zkOptions.concurrency = n;
    }
    if (opts.chunkSize !== undefined) {
      const bytes = parseChunkSize(opts.chunkSize);
      if (bytes !== null) zkOptions.chunkSize = bytes;
    }
    const zip = new ZipKit(zkOptions);

    const spec: ExtractSpec = { archive, signal };
    if (dest !== undefined) spec.dest = dest;
    if (opts.dryRun) spec.dryRun = true;
    if (opts.overwrite) spec.overwrite = true;
    if (opts.checkMetadata) spec.checkMetadata = true;
    if (opts.metadataName !== undefined) spec.metadataName = opts.metadataName;
    if (opts.timestamps === false) spec.timestamps = "none";
    if (opts.timezone !== undefined) spec.timezone = opts.timezone;
    if (opts.onUnsafe !== undefined) spec.onUnsafe = opts.onUnsafe;
    if (opts.symlinks !== undefined) spec.symlinks = opts.symlinks;
    if (excludes.length > 0) spec.exclude = excludes;

    try {
      const data = await zip.extract(spec);
      await emit(opts, data);
      if (!data.reportOk) setExitCode(1);
    } catch (err) {
      if (err instanceof ZipKitError && err.errorType === "abort") throw err;
      // A usage fault is pre-verb — no per-entry report to fold into — so
      // re-throw it to the run layer (exit 2 + the D5 minimal envelope under
      // `--json`). Any other read fault is operational and is folded into the
      // report as its SSOT finding.
      if (isUsageFault(err)) throw err;
      const fault = toFault(err, spec.archive);
      if (opts.json) emitErrorEvent({ code: fault.code, message: fault.message, path: fault.path });
      else emitHumanError(fault.code, fault.message);
      await emit(opts, faultData(spec, fault));
      setExitCode(1);
    }
  });
}

/** Emit the extract report: the envelope (or human render) on stdout, plus the
 *  independent `--json-out` file lever. */
async function emit(opts: ExtractOpts, data: ExtractData): Promise<void> {
  const report = buildReport("extract", data);
  if (opts.json) emitReport(report);
  else process.stdout.write(renderExtractData(data));
  if (opts.jsonOut !== undefined) await writeReportFile(opts.jsonOut, report);
}
