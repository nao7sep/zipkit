/**
 * The `extract` subcommand. One verb covers extraction and validation: with a
 * destination it writes verified entries; with `--dry-run` it writes nothing and
 * only reports (a pure integrity test, the `unzip -t` shape). `--check-metadata`
 * adds manifest reconciliation and SHA verification. CRC-32 is always checked.
 * The exit code is 0 when the report is `ok`, else 1, so it scripts cleanly.
 */

import type { Command } from "commander";
import { ZipKit } from "../zipkit.js";
import type { ExtractSpec, ZipKitOptions } from "../types.js";
import { emitJson } from "./json.js";
import { createConsoleProgress, renderExtractReport } from "./render.js";

interface ExtractOpts {
  dryRun?: boolean;
  overwrite?: boolean;
  checkMetadata?: boolean;
  metadataName?: string;
  timestamps?: boolean; // commander's --no-timestamps sets this false
  timezone?: string;
  onUnsafe?: "skip" | "abort";
  symlinks?: "restore" | "skip";
  exclude?: string[];
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
}

export function registerExtract(
  program: Command,
  signal: AbortSignal,
  setExitCode: (code: number) => void,
): void {
  const cmd = program
    .command("extract")
    .description("Extract or validate a ZIP archive")
    .argument("<archive>", "the .zip file to read")
    .argument("[dest]", "output directory (omit with --dry-run to validate only)");

  cmd.option("--dry-run", "validate only: verify CRC and write nothing");
  cmd.option("--overwrite", "overwrite existing files at the destination");
  cmd.option("--check-metadata", "reconcile entries against the manifest and verify SHA-256");
  cmd.option("--metadata-name <name>", "manifest name to look for (default _metadata.json)");
  cmd.option("--no-timestamps", "do not restore modification/access times");
  cmd.option("--timezone <iana>", "zone for the DOS field when an entry has no UTC time extra");
  cmd.option("--on-unsafe <skip|abort>", "handling of paths that escape the destination (default skip)");
  cmd.option("--symlinks <restore|skip>", "symlink handling (default restore)");
  cmd.option(
    "--exclude <name>",
    "entry name not to write (repeatable)",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  );
  cmd.option("--quiet", "suppress console progress");
  cmd.option("--verbose", "include per-entry detail in console progress");
  cmd.option("--json", "emit the report as JSON; suppress the human renderer");

  cmd.action(async (archive: string, dest: string | undefined, opts: ExtractOpts) => {
    const zkOptions: ZipKitOptions = {};
    if (!opts.json && !opts.quiet) {
      zkOptions.logger = createConsoleProgress(opts.verbose === true);
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
    if (opts.exclude && opts.exclude.length > 0) spec.exclude = opts.exclude;

    const report = await zip.extract(spec);
    if (opts.json) emitJson(report);
    else process.stdout.write(renderExtractReport(report));
    if (!report.ok) setExitCode(1);
  });
}
