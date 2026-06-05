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
import { exitCodeFor, ZipKitError } from "../errors.js";
import { globExclude, regexExclude } from "../filter/rules.js";
import { METADATA_DEFAULTS } from "../policy.js";
import { buildReport } from "../report.js";
import type {
  ArchiveInput,
  ArchivePolicy,
  ArchiveSpec,
  CompressionPolicy,
  CreateData,
  FilterRule,
  NameAction,
  NameRules,
  ZipKitCallOptions,
  ZipKitOptions,
} from "../types.js";
import { emitFaultLive, emitReport, faultFinding, toFault } from "./json.js";
import { parseByteSize, parseInteger } from "./parsers.js";
import { buildReporter } from "./reporter.js";
import { renderCreateData } from "./render.js";

/** The `mode:"plan"` member of {@link CreateData}; what `plan()` returns. */
type PlanData = Extract<CreateData, { mode: "plan" }>;

interface CreateOpts {
  root?: string;
  wrap?: boolean;
  output?: string;
  overwrite?: boolean;
  junk?: "builtin" | "none";
  skipEmptyFiles?: boolean;
  emptyDirs?: "keep" | "prune";
  emptyDirDef?: "strict" | "recursive";
  invalidChar?: string;
  nameNfc?: NameAction;
  nameInvalid?: NameAction;
  nameControl?: NameAction;
  nameTrailing?: NameAction;
  nameReserved?: NameAction;
  nameSuspicious?: "warn" | "error" | "none";
  collisionCase?: "insensitive" | "sensitive";
  symlinks?: "ignore" | "preserve" | "follow";
  followExternal?: boolean;
  timestamps?: "clamp" | "preserve";
  timezone?: string;
  stored?: "builtin" | "none";
  level?: number;
  comment?: string;
  metadata?: boolean; // commander's --no-metadata sets this false (default true)
  metadataNoHash?: boolean;
  metadataName?: string;
  zip64?: "auto" | "never" | "always";
  dryRun?: boolean;
  log?: string;
  quiet?: boolean;
  verbose?: boolean;
  concurrency?: number;
  chunkSize?: number;
  json?: boolean;
}

/** Split a `--store` value's comma list into trimmed, non-empty tokens. A
 *  single flag may carry a comma list (`jpg,png`) and the flag is repeatable, so
 *  both `--store jpg,png` and `--store jpg --store png` reach the same set.
 *  Extension-dialect normalization (case, leading dot) is the SDK's job
 *  (`resolvePolicy`), so this only handles the comma-list shape. */
function splitList(value: string): string[] {
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

  if (opts.junk) policy.junk = opts.junk;
  if (filters.length > 0) policy.filters = filters;
  if (opts.skipEmptyFiles) policy.emptyFiles = "skip";
  if (opts.emptyDirs) policy.emptyDirs = opts.emptyDirs;
  if (opts.emptyDirDef) policy.emptyDirDefinition = opts.emptyDirDef;

  // Naming: the per-feature actions and the invalid-character replacement form
  // one partial `names` object that resolvePolicy completes from the defaults.
  const names: Partial<NameRules> = {};
  if (opts.invalidChar !== undefined) names.invalidCharReplacement = opts.invalidChar;
  if (opts.nameNfc) names.nfc = opts.nameNfc;
  if (opts.nameInvalid) names.invalidChars = opts.nameInvalid;
  if (opts.nameControl) names.controlChars = opts.nameControl;
  if (opts.nameTrailing) names.trailingDotSpace = opts.nameTrailing;
  if (opts.nameReserved) names.reserved = opts.nameReserved;
  if (opts.nameSuspicious) names.suspicious = opts.nameSuspicious;
  if (Object.keys(names).length > 0) policy.names = names as NameRules;

  if (opts.collisionCase) policy.collisionCase = opts.collisionCase;

  if (opts.symlinks) policy.symlinks = opts.symlinks;
  if (opts.followExternal) policy.followExternal = true;
  if (opts.timestamps) policy.timestamps = opts.timestamps;
  if (opts.timezone !== undefined) policy.timezone = opts.timezone;

  const store = storeAdds.length > 0 ? storeAdds : undefined;
  const level = opts.level;
  if (opts.stored !== undefined || store !== undefined || level !== undefined) {
    const compression: Partial<CompressionPolicy> = {};
    if (opts.stored !== undefined) compression.stored = opts.stored;
    if (store !== undefined) compression.store = store;
    if (level !== undefined) compression.level = level;
    policy.compression = compression as CompressionPolicy;
  }

  // Metadata is embedded by default (the policy default). `--no-metadata` sets
  // `opts.metadata` false and turns it off; the sub-options only refine the
  // default-on record, so leaving them unset keeps the default.
  if (opts.metadata === false) {
    policy.metadata = false;
  } else if (opts.metadataNoHash || opts.metadataName) {
    policy.metadata = {
      name: opts.metadataName ?? METADATA_DEFAULTS.name,
      hash: opts.metadataNoHash !== true,
    };
  }

  if (opts.zip64) policy.zip64 = opts.zip64;

  return policy;
}

function buildSpec(
  rawInputs: string[],
  opts: CreateOpts,
  filters: FilterRule[],
  storeAdds: string[],
): ArchiveSpec {
  const inputs: ArchiveInput[] =
    opts.wrap && rawInputs.length === 1 && rawInputs[0] !== undefined
      ? [{ path: rawInputs[0], flatten: false }]
      : rawInputs;

  const spec: ArchiveSpec = { inputs };
  if (opts.root !== undefined) spec.root = opts.root;
  if (opts.output !== undefined) spec.output = opts.output;
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
    storeAdds.push(...splitList(value));
    return value;
  };

  const cmd = program
    .command("create")
    .description("Create a clean, cross-platform ZIP archive from a source tree")
    .argument("<inputs...>", "files and directories to archive");

  // Source
  cmd.option("--root <dir>", "root every input's archive path relative to this directory");
  cmd.option(
    "--wrap",
    "single directory: keep its name as the top folder (default: flatten its contents to the root)",
  );

  // Destination
  cmd.option("-o, --output <path>", "output archive path");
  cmd.option("--overwrite", "overwrite an existing output");
  cmd.option("--comment <text>", "archive comment, stored in the ZIP and the metadata");

  // Selection
  cmd.option("--junk <builtin|none>", "junk preset (default builtin)");
  cmd.option("--exclude <pattern>", "exclude glob (repeatable); trailing slash = directory", addGlob);
  cmd.option("--exclude-regex <pattern>", "exclude regex (repeatable)", addRegex);
  cmd.option("--skip-empty-files", "drop zero-byte files");
  cmd.option("--empty-dirs <keep|prune>", "empty-directory handling (default keep)");
  cmd.option("--empty-dir-def <strict|recursive>", "empty-directory definition (default recursive)");

  // Naming. Each name guardrail takes an action: fix (repair, the default) |
  // warn (report, do not block) | error (report and fail) | none (silent).
  const nameAction = " <fix|warn|error|none>";
  cmd.option(`--name-nfc${nameAction}`, "non-NFC names (e.g. macOS NFD) → NFC");
  cmd.option(`--name-invalid${nameAction}`, "Windows-illegal characters < > : \" | ? *");
  cmd.option(`--name-control${nameAction}`, "control characters below 0x20");
  cmd.option(`--name-trailing${nameAction}`, "trailing dots or spaces");
  cmd.option(`--name-reserved${nameAction}`, "reserved device names (CON, PRN, …)");
  cmd.option(
    "--name-suspicious <warn|error|none>",
    "zero-width / bidi-override characters (kept; never fixed)",
  );
  cmd.option(
    "--invalid-char <char>",
    'replacement for invalid characters; a single path component, no slashes (default "_")',
  );
  cmd.option(
    "--collision-case <insensitive|sensitive>",
    "whether case-only path differences collide (default insensitive)",
  );

  // Entry data
  cmd.option("--symlinks <ignore|preserve|follow>", "symlink handling (default ignore)");
  cmd.option("--follow-external", "under follow, allow links that escape the input tree");
  cmd.option(
    "--timestamps <preserve|clamp>",
    "timestamp policy (default preserve): preserve writes the UTC extras, clamp writes only the DOS field",
  );
  cmd.option(
    "--timezone <iana>",
    "IANA zone for the DOS local-time field, e.g. Asia/Tokyo (default: host zone)",
  );
  cmd.option(
    "--stored <builtin|none>",
    "baseline of extensions kept uncompressed (default builtin); none deflates everything not named by --store",
  );
  cmd.option(
    "--store <ext>",
    "keep this extension uncompressed, with or without a leading dot (repeatable, comma-list ok); adds to the --stored baseline",
    addStore,
  );
  cmd.option("--level <1-9>", "deflate level, 1 (fastest) to 9 (smallest) (default 6)", parseInteger);

  // Companion output
  cmd.option("--no-metadata", "do not embed the metadata file (produce a plain archive)");
  cmd.option("--metadata-no-hash", "omit the per-file SHA-256 (CRC-32 is always recorded)");
  cmd.option(
    "--metadata-name <name>",
    "metadata entry name, a single path component (default _metadata.json)",
  );

  // Container format
  cmd.option("--zip64 <auto|never|always>", "Zip64 policy (default auto)");

  // Diagnostics and control
  cmd.option("--dry-run", "compute and render the plan; write nothing");
  cmd.option("--log <path.jsonl>", "write the event stream as JSONL");
  cmd.option("--quiet", "suppress console progress");
  cmd.option("--verbose", "include per-entry detail in console progress");
  cmd.option(
    "--concurrency <n>",
    "maximum concurrent file operations (default: available CPUs, bounded 4–16)",
    parseInteger,
  );
  cmd.option(
    "--chunk-size <size>",
    "streamed-I/O chunk size in bytes; accepts a k/m suffix (default 64k)",
    parseByteSize,
  );
  cmd.option("--json", "emit the report envelope as pretty JSON on stdout, progress as JSONL on stderr");

  cmd.action(async (rawInputs: string[], opts: CreateOpts) => {
    // Construct the SDK first so an out-of-range --concurrency/--chunk-size fails
    // (a usage exit) before the --log file is opened. Format coercion already
    // happened at the parse edge; the SDK owns the bounds.
    const zkOptions: ZipKitOptions = {};
    if (opts.concurrency !== undefined) zkOptions.concurrency = opts.concurrency;
    if (opts.chunkSize !== undefined) zkOptions.chunkSize = opts.chunkSize;
    const zip = new ZipKit(zkOptions);

    const reporter = buildReporter(opts);
    const callOptions: ZipKitCallOptions = { onProgress: reporter.sink, signal };
    const spec = buildSpec(rawInputs, opts, filters, storeAdds);

    try {
      // The SDK's plan() → write() split is what lets the CLI own the envelope:
      // on a write fault it still holds the plan, folds the fault into findings,
      // and emits the report. A plan() throw has no data yet, so it propagates to
      // the run layer (the pre-verb fault path).
      const plan = await zip.plan(spec, callOptions);

      if (opts.dryRun) {
        emit(opts, plan);
        if (!plan.writable) setExitCode(1);
        return;
      }

      // The create soft-failure gate: a non-writable plan never reaches the
      // writer. Emit a write-mode report carrying the blocking findings and a
      // not-written verdict, then exit 1 (a negative domain verdict).
      if (!plan.writable) {
        emit(opts, notWritten(plan));
        setExitCode(1);
        return;
      }

      try {
        const result = await zip.write(plan, callOptions);
        emit(opts, result);
        if (!result.written) setExitCode(1);
      } catch (err) {
        if (err instanceof ZipKitError && err.errorType === "abort") throw err;
        // An operational write fault: surface it live on stderr, fold it into
        // the held plan's findings as an error-tier finding, and emit the
        // write-mode report. The exit code is the fault's domain (write → 4).
        const fault = toFault(err, plan.output);
        emitFaultLive(opts.json === true, fault);
        const data = notWritten(plan);
        data.findings = [...plan.findings, faultFinding(fault)];
        emit(opts, data);
        setExitCode(exitCodeFor(err));
      }
    } finally {
      await reporter.finalize();
    }
  });
}

/** The write-mode report for a create that never wrote — the soft-failure gate
 *  and the write-fault path both produce this, carrying the plan's SSOT. */
function notWritten(plan: PlanData): Extract<CreateData, { mode: "write" }> {
  return {
    mode: "write",
    output: plan.output,
    writable: plan.writable,
    written: false,
    bytes: null,
    zip64: false,
    summary: plan.summary,
    findings: plan.findings,
    metadata: null,
  };
}

/** Emit the create report: the envelope (or human render) on stdout. */
function emit(opts: CreateOpts, data: CreateData): void {
  if (opts.json) emitReport(buildReport("create", data));
  else process.stdout.write(renderCreateData(data));
}
