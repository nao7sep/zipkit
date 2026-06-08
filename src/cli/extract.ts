/**
 * The `extract` subcommand. One verb covers extraction and validation: with a
 * destination it writes verified entries; with `--dry-run` it writes nothing and
 * only reports (a pure integrity test, the `unzip -t` shape). `--check-metadata`
 * adds manifest reconciliation and SHA verification. CRC-32 is always checked.
 * The exit code is 0 when the report is `ok`, else 1, so it scripts cleanly.
 */

import type { Command } from "commander";
import { ZipKit } from "../zipkit.js";
import { globExclude, regexExclude } from "../filter/rules.js";
import type {
  ExtractSpec,
  FilterRule,
  ZipKitCallOptions,
  ZipKitOptions,
} from "../types.js";
import { emit } from "./output.js";
import { parseByteSize, parseInteger } from "./parsers.js";
import { buildReporter } from "./reporter.js";

interface ExtractOpts {
  dryRun?: boolean;
  overwrite?: boolean;
  checkMetadata?: boolean;
  metadataName?: string;
  timestamps?: boolean; // commander's --no-timestamps sets this false
  timezone?: string;
  onUnsafe?: "skip" | "abort";
  symlinks?: "restore" | "skip";
  log?: string;
  quiet?: boolean;
  jobs?: number;
  chunkSize?: number;
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
  cmd.option("--metadata-name <name>", "manifest entry name inside the archive");
  cmd.option("--no-timestamps", "do not restore modification/access times");
  cmd.option("--timezone <iana>", "zone for the DOS field when an entry has no UTC time extra");
  cmd.option("--on-unsafe <skip|abort>", "handling of paths that escape the destination (zip-slip)");
  cmd.option("--symlinks <restore|skip>", "symlink handling");
  cmd.option("--exclude <pattern>", "exclude glob, not written (repeatable); trailing slash = directory", addGlob);
  cmd.option("--exclude-regex <pattern>", "exclude regex, not written (repeatable)", addRegex);
  cmd.option("--log <path.jsonl>", "write the event stream as JSONL");
  cmd.option("--quiet", "suppress console progress");
  cmd.option(
    "-j, --jobs <n>",
    "maximum entries extracted in parallel",
    parseInteger,
  );
  cmd.option(
    "--chunk-size <size>",
    "streamed-I/O chunk size in bytes; accepts a k/m suffix",
    parseByteSize,
  );

  cmd.action(async (archive: string, dest: string | undefined, opts: ExtractOpts) => {
    // Construct the SDK first so an out-of-range --jobs/--chunk-size fails
    // (a usage exit) before the --log file is opened. Format coercion already
    // happened at the parse edge; the SDK owns the bounds.
    const zkOptions: ZipKitOptions = {};
    if (opts.jobs !== undefined) zkOptions.concurrency = opts.jobs;
    if (opts.chunkSize !== undefined) zkOptions.chunkSize = opts.chunkSize;
    const zip = new ZipKit(zkOptions);

    const reporter = buildReporter(opts);
    const callOptions: ZipKitCallOptions = { onProgress: reporter.sink, signal };

    const spec: ExtractSpec = { archive };
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
      // The verb emits its typed result to stdout and exits 1 on a negative
      // verdict (a report that is not ok — a CRC failure, an unsafe path, a SHA
      // mismatch); the per-entry detail rides on that result. Operational read
      // faults are not caught here — they propagate to the run layer, which
      // renders them on stderr and maps the exit code, leaving stdout empty.
      const data = await zip.extract(spec, callOptions);
      emit(data);
      if (!data.reportOk) setExitCode(1);
    } finally {
      await reporter.finalize();
    }
  });
}
