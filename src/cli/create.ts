/**
 * The `create` subcommand. Flags follow the master concern order. Three
 * behaviours are normative: `--exclude` and `--exclude-regex` append to one
 * shared ordered list (any match drops the entry — the system is inclusive by
 * default, so there is no include); a trailing slash on a glob targets
 * directories; and `--dry-run` is the CLI form of calling `plan()`. The action
 * maps flags to an `ArchiveSpec` plus per-call policy, wires the log stream to
 * the console and the optional JSONL sink, and chooses `plan()` or `create()`.
 */

import type { Command } from "commander";
import { ZipKit } from "../zipkit.js";
import { globExclude, regexExclude } from "../filter/rules.js";
import { METADATA_DEFAULTS } from "../policy.js";
import type {
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
  FilterRule,
  NameAction,
  NameRules,
  ZipKitCallOptions,
  ZipKitOptions,
} from "../types.js";
import { emit } from "./output.js";
import { parseByteSize, parseInteger } from "./parsers.js";
import { buildReporter } from "./reporter.js";

interface CreateOpts {
  out?: string;
  overwrite?: boolean;
  junk?: boolean; // commander's --no-junk sets this false (default true)
  skipEmptyFiles?: boolean;
  emptyDirs?: "keep" | "prune";
  replacement?: string;
  nameNfc?: NameAction;
  nameInvalid?: NameAction;
  nameControl?: NameAction;
  nameTrailing?: NameAction;
  nameReserved?: NameAction;
  nameSuspicious?: "warn" | "error" | "none";
  symlinks?: "ignore" | "preserve" | "follow";
  followExternal?: boolean;
  timezone?: string;
  stored?: boolean; // commander's --no-stored sets this false (default true)
  level?: number;
  comment?: string;
  metadata?: boolean; // commander's --no-metadata sets this false (default true)
  hash?: boolean; // commander's --no-hash sets this false (default true)
  metadataName?: string;
  dryRun?: boolean;
  log?: string;
  quiet?: boolean;
  jobs?: number;
  chunkSize?: number;
}

/** Split a `--store` value's comma list into trimmed, non-empty tokens. A
 *  single flag may carry a comma list (`jpg,png`) and the flag is repeatable, so
 *  both `--store jpg,png` and `--store jpg --store png` reach the same set.
 *  Extension-dialect normalization (case, leading dot) is the SDK's job
 *  (`resolvePolicy`), so this only handles the comma-list shape. */
function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildPolicy(
  opts: CreateOpts,
  filters: FilterRule[],
  storeAdds: string[],
): Partial<ArchivePolicy> {
  const policy: Partial<ArchivePolicy> = {};

  if (opts.junk === false) policy.junk = "none";
  if (filters.length > 0) policy.filters = filters;
  if (opts.skipEmptyFiles) policy.emptyFiles = "skip";
  if (opts.emptyDirs) policy.emptyDirs = opts.emptyDirs;

  // Naming: the per-feature actions and the invalid-character replacement form
  // one partial `names` object that resolvePolicy completes from the defaults.
  const names: Partial<NameRules> = {};
  if (opts.replacement !== undefined) names.invalidCharReplacement = opts.replacement;
  if (opts.nameNfc) names.nfc = opts.nameNfc;
  if (opts.nameInvalid) names.invalidChars = opts.nameInvalid;
  if (opts.nameControl) names.controlChars = opts.nameControl;
  if (opts.nameTrailing) names.trailingDotSpace = opts.nameTrailing;
  if (opts.nameReserved) names.reserved = opts.nameReserved;
  if (opts.nameSuspicious) names.suspicious = opts.nameSuspicious;
  if (Object.keys(names).length > 0) policy.names = names as NameRules;

  if (opts.symlinks) policy.symlinks = opts.symlinks;
  if (opts.followExternal) policy.followExternal = true;
  if (opts.timezone !== undefined) policy.timezone = opts.timezone;

  const store = storeAdds.length > 0 ? storeAdds : undefined;
  const level = opts.level;
  const storedNone = opts.stored === false;
  if (storedNone || store !== undefined || level !== undefined) {
    const compression: Partial<CompressionPolicy> = {};
    if (storedNone) compression.stored = "none";
    if (store !== undefined) compression.store = store;
    if (level !== undefined) compression.level = level;
    policy.compression = compression as CompressionPolicy;
  }

  // Metadata is embedded by default (the policy default). `--no-metadata` sets
  // `opts.metadata` false and turns it off; the sub-options only refine the
  // default-on record, so leaving them unset keeps the default.
  if (opts.metadata === false) {
    policy.metadata = false;
  } else if (opts.hash === false || opts.metadataName) {
    policy.metadata = {
      name: opts.metadataName ?? METADATA_DEFAULTS.name,
      hash: opts.hash !== false,
    };
  }

  return policy;
}

function buildSpec(
  rawInputs: string[],
  opts: CreateOpts,
  filters: FilterRule[],
  storeAdds: string[],
): ArchiveSpec {
  const spec: ArchiveSpec = { inputs: rawInputs };
  if (opts.out !== undefined) spec.output = opts.out;
  if (opts.overwrite) spec.overwrite = true;
  if (opts.comment !== undefined) spec.comment = opts.comment;

  const policy = buildPolicy(opts, filters, storeAdds);
  if (Object.keys(policy).length > 0) spec.policy = policy;

  return spec;
}

export function registerCreate(
  program: Command,
  signal: AbortSignal,
  setExitCode: (code: number) => void,
): void {
  const filters: FilterRule[] = [];
  const storeAdds: string[] = [];

  const addGlob = (pattern: string) => {
    filters.push(globExclude(pattern));
    return pattern;
  };
  const addRegex = (pattern: string) => {
    filters.push(regexExclude(pattern));
    return pattern;
  };
  const addStore = (value: string) => {
    storeAdds.push(...splitCsv(value));
    return value;
  };

  const cmd = program
    .command("create")
    .description("Create a clean, cross-platform ZIP archive from a source tree")
    .argument("<inputs...>", "files and directories to archive");

  // Destination
  cmd.option("-o, --out <path>", "output archive path");
  cmd.option("--overwrite", "overwrite an existing output");
  cmd.option("--comment <text>", "archive comment, stored in the ZIP and the metadata");

  // Selection
  cmd.option("--no-junk", "disable the built-in OS-junk preset");
  cmd.option("--exclude <pattern>", "exclude glob (repeatable); trailing slash = directory", addGlob);
  cmd.option("--exclude-regex <pattern>", "exclude regex (repeatable)", addRegex);
  cmd.option("--skip-empty-files", "drop zero-byte files");
  cmd.option("--empty-dirs <keep|prune>", "empty-directory handling");

  // Naming. Each name guardrail takes an action: fix (repair, the default) |
  // warn (report, do not block) | error (report and fail) | none (silent).
  const nameAction = " <fix|warn|error|none>";
  cmd.option(`--name-nfc${nameAction}`, "non-NFC names (e.g. macOS NFD) → NFC");
  cmd.option(`--name-invalid${nameAction}`, "Windows-illegal characters < > : \" | ? * \\");
  cmd.option(`--name-control${nameAction}`, "control characters below 0x20");
  cmd.option(`--name-trailing${nameAction}`, "trailing dots or spaces");
  cmd.option(`--name-reserved${nameAction}`, "reserved device names (CON, PRN, …)");
  cmd.option(
    "--name-suspicious <warn|error|none>",
    "zero-width / bidi-override characters (kept; never fixed)",
  );
  cmd.option(
    "--replacement <char>",
    "substitute for invalid characters; a single path component, no slashes",
  );

  // Entry data
  cmd.option("--symlinks <ignore|preserve|follow>", "symlink handling");
  cmd.option("--follow-external", "under follow, allow links that escape the input tree");
  cmd.option(
    "--timezone <iana>",
    "IANA zone for the DOS local-time field, e.g. Asia/Tokyo",
  );
  cmd.option(
    "--no-stored",
    "disable the built-in already-compressed list; deflate everything not named by --store",
  );
  cmd.option(
    "--store <ext>",
    "keep this extension uncompressed, with or without a leading dot (repeatable, comma-list ok); adds to the built-in list",
    addStore,
  );
  cmd.option("--level <1-9>", "deflate level, 1 (fastest) to 9 (smallest)", parseInteger);

  // Companion output
  cmd.option("--no-metadata", "do not embed the metadata file (produce a plain archive)");
  cmd.option("--no-hash", "omit the per-file SHA-256 (CRC-32 is always recorded)");
  cmd.option(
    "--metadata-name <name>",
    "metadata entry name, a single path component",
  );

  // Diagnostics and control
  cmd.option("--dry-run", "compute and render the plan; write nothing");
  cmd.option("--log <path.jsonl>", "write the event stream as JSONL");
  cmd.option("--quiet", "suppress console progress");
  cmd.option(
    "-j, --jobs <n>",
    "maximum concurrent file operations (the scan and hashing; the archive write is sequential)",
    parseInteger,
  );
  cmd.option(
    "--chunk-size <size>",
    "streamed-I/O chunk size in bytes; accepts a k/m suffix",
    parseByteSize,
  );

  cmd.action(async (rawInputs: string[], opts: CreateOpts) => {
    // Construct the SDK first so an out-of-range --jobs/--chunk-size fails
    // (a usage exit) before the --log file is opened. Format coercion already
    // happened at the parse edge; the SDK owns the bounds.
    const zkOptions: ZipKitOptions = {};
    if (opts.jobs !== undefined) zkOptions.concurrency = opts.jobs;
    if (opts.chunkSize !== undefined) zkOptions.chunkSize = opts.chunkSize;
    const zip = new ZipKit(zkOptions);

    const reporter = buildReporter(opts);
    const callOptions: ZipKitCallOptions = { onProgress: reporter.sink, signal };
    const spec = buildSpec(rawInputs, opts, filters, storeAdds);

    try {
      // The SDK's plan() → write() split surfaces the validator verdict: a
      // dry run or a non-writable plan emits the plan result to stdout (with its
      // blocking findings) and exits 1 — a clean run whose answer is "no", not a
      // fault. Operational faults from plan() or write() are not caught here;
      // they propagate to the run layer, which renders them on stderr and maps
      // the exit code, leaving stdout empty.
      const plan = await zip.plan(spec, callOptions);

      if (opts.dryRun || !plan.writable) {
        emit(plan);
        if (!plan.writable) setExitCode(1);
        return;
      }

      emit(await zip.write(plan, callOptions));
    } finally {
      await reporter.finalize();
    }
  });
}
