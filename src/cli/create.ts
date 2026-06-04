/**
 * The `create` subcommand. Flags follow the master concern order. Three
 * behaviours are normative: all four include/exclude flags append to one
 * shared ordered list in command-line order (so first-match-wins works across
 * mixed flags); a trailing slash on a glob targets directories; and `--dry-run`
 * is the CLI form of calling `plan()`. The action maps flags to an
 * `ArchiveSpec` plus per-call policy, wires the log stream to the console and
 * the optional JSONL sink, and chooses `plan()` or `create()` by mode.
 */

import type { Command } from "commander";
import { ZipKit } from "../zipkit.js";
import { DEFAULT_STORE_EXTENSIONS, METADATA_DEFAULTS } from "../policy.js";
import type { LogSink } from "../log/logger.js";
import type {
  ArchiveInput,
  ArchivePolicy,
  ArchiveSpec,
  FilterRule,
  ZipKitOptions,
} from "../types.js";
import { emitJson } from "./json.js";
import { createJsonlSink } from "./logSink.js";
import { createConsoleProgress, renderPlan, renderResult } from "./render.js";

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
  symlinks?: "ignore" | "preserve" | "follow";
  followExternal?: boolean;
  timestamps?: "clamp" | "preserve";
  storeExt?: string | false;
  storeAll?: boolean;
  compressAll?: boolean;
  metadata?: boolean;
  metadataHash?: boolean;
  metadataName?: string;
  metadataPlacement?: "inside" | "sidecar";
  zip64?: "auto" | "never" | "always";
  deterministic?: boolean;
  dryRun?: boolean;
  strict?: boolean;
  log?: string;
  quiet?: boolean;
  verbose?: boolean;
  concurrency?: string;
  json?: boolean;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(".") ? s.toLowerCase() : `.${s.toLowerCase()}`));
}

function buildPolicy(opts: CreateOpts, filters: FilterRule[]): Partial<ArchivePolicy> {
  const policy: Partial<ArchivePolicy> = {};

  if (opts.junk) policy.junk = opts.junk;
  if (filters.length > 0) policy.filters = filters;
  if (opts.skipEmptyFiles) policy.emptyFiles = "skip";
  if (opts.emptyDirs) policy.emptyDirs = opts.emptyDirs;
  if (opts.emptyDirDef) policy.emptyDirDefinition = opts.emptyDirDef;

  if (opts.invalidChar !== undefined) policy.invalidCharReplacement = opts.invalidChar;

  if (opts.symlinks) policy.symlinks = opts.symlinks;
  if (opts.followExternal) policy.followExternal = true;
  if (opts.timestamps) policy.timestamps = opts.timestamps;

  const mode = opts.compressAll ? "compress-all" : opts.storeAll ? "store-all" : undefined;
  const storeExtensions =
    opts.storeExt === false
      ? []
      : typeof opts.storeExt === "string"
        ? splitList(opts.storeExt)
        : undefined;
  if (mode !== undefined || storeExtensions !== undefined) {
    policy.compression = {
      mode: mode ?? "auto",
      storeExtensions: storeExtensions ?? [...DEFAULT_STORE_EXTENSIONS],
    };
  }

  if (opts.metadata || opts.metadataHash || opts.metadataName || opts.metadataPlacement) {
    policy.metadata = {
      name: opts.metadataName ?? METADATA_DEFAULTS.name,
      placement: opts.metadataPlacement ?? METADATA_DEFAULTS.placement,
      hash: opts.metadataHash === true,
    };
  }

  if (opts.zip64) policy.zip64 = opts.zip64;
  if (opts.deterministic) policy.deterministic = true;
  if (opts.strict) policy.strict = true;

  return policy;
}

function buildSpec(
  rawInputs: string[],
  opts: CreateOpts,
  filters: FilterRule[],
  signal: AbortSignal,
): ArchiveSpec {
  const inputs: ArchiveInput[] =
    opts.wrap && rawInputs.length === 1 && rawInputs[0] !== undefined
      ? [{ path: rawInputs[0], flatten: false }]
      : rawInputs;

  const spec: ArchiveSpec = { inputs, signal };
  if (opts.root !== undefined) spec.root = opts.root;
  if (opts.output !== undefined) spec.output = opts.output;
  if (opts.overwrite) spec.overwrite = true;

  const policy = buildPolicy(opts, filters);
  if (Object.keys(policy).length > 0) spec.policy = policy;

  return spec;
}

function buildReporter(opts: CreateOpts): { sink: LogSink; finalize: () => Promise<void> } {
  const sinks: LogSink[] = [];
  let jsonl: ReturnType<typeof createJsonlSink> | undefined;
  if (opts.log !== undefined) {
    jsonl = createJsonlSink(opts.log);
    sinks.push(jsonl.sink);
  }
  if (!opts.json && !opts.quiet) {
    sinks.push(createConsoleProgress(opts.verbose === true));
  }
  return {
    sink: (event) => {
      for (const sink of sinks) sink(event);
    },
    finalize: async () => {
      if (jsonl) await jsonl.close();
    },
  };
}

export function registerCreate(
  program: Command,
  signal: AbortSignal,
  setExitCode: (code: number) => void,
): void {
  const filters: FilterRule[] = [];

  const globFilter = (action: FilterRule["action"]) => (pattern: string) => {
    filters.push({
      action,
      pattern,
      match: "glob",
      target: pattern.endsWith("/") ? "dir" : "both",
    });
    return pattern;
  };
  const regexFilter = (action: FilterRule["action"]) => (pattern: string) => {
    filters.push({ action, pattern, match: "regex", target: "both" });
    return pattern;
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

  // Selection
  cmd.option("--junk <builtin|none>", "junk preset (default builtin)");
  cmd.option("--include <pattern>", "include glob (repeatable, ordered)", globFilter("include"));
  cmd.option("--exclude <pattern>", "exclude glob (repeatable, ordered)", globFilter("exclude"));
  cmd.option(
    "--include-regex <pattern>",
    "include regex (repeatable, ordered)",
    regexFilter("include"),
  );
  cmd.option(
    "--exclude-regex <pattern>",
    "exclude regex (repeatable, ordered)",
    regexFilter("exclude"),
  );
  cmd.option("--skip-empty-files", "drop zero-byte files");
  cmd.option("--empty-dirs <keep|prune>", "empty-directory handling (default keep)");
  cmd.option("--empty-dir-def <strict|recursive>", "empty-directory definition (default recursive)");

  // Naming
  cmd.option("--invalid-char <char>", 'replacement for invalid characters (default "_")');

  // Entry data
  cmd.option("--symlinks <ignore|preserve|follow>", "symlink handling (default ignore)");
  cmd.option("--follow-external", "under follow, allow links that escape the input tree");
  cmd.option("--timestamps <clamp|preserve>", "timestamp policy (default clamp)");
  cmd.option("--store-ext <list>", "comma-separated extensions to store without deflating");
  cmd.option("--no-store-ext", "deflate everything (clear the store list)");
  cmd.option("--store-all", "store every entry");
  cmd.option("--compress-all", "deflate every entry");

  // Companion output
  cmd.option("--metadata", "emit the metadata file");
  cmd.option("--metadata-hash", "include a SHA-256 per file in the metadata");
  cmd.option("--metadata-name <name>", "metadata file name (default _metadata.json)");
  cmd.option("--metadata-placement <inside|sidecar>", "metadata placement (default inside)");

  // Container format
  cmd.option("--zip64 <auto|never|always>", "Zip64 policy (default auto)");
  cmd.option("--deterministic", "reproducible output: sorted entries, fixed time");

  // Diagnostics and control
  cmd.option("--dry-run", "compute and render the plan; write nothing");
  cmd.option("--strict", "treat warnings as blocking");
  cmd.option("--log <path.jsonl>", "write the event stream as JSONL");
  cmd.option("--quiet", "suppress console progress");
  cmd.option("--verbose", "include per-entry detail in console progress");
  cmd.option("--concurrency <n>", "maximum concurrent file operations");
  cmd.option("--json", "emit the plan or result as JSON; suppress the human renderer");

  cmd.action(async (rawInputs: string[], opts: CreateOpts) => {
    const reporter = buildReporter(opts);
    const zkOptions: ZipKitOptions = { logger: reporter.sink };
    if (opts.concurrency !== undefined) {
      const n = Number.parseInt(opts.concurrency, 10);
      if (Number.isFinite(n) && n > 0) zkOptions.concurrency = n;
    }
    const zip = new ZipKit(zkOptions);
    const spec = buildSpec(rawInputs, opts, filters, signal);

    try {
      if (opts.dryRun) {
        const plan = await zip.plan(spec);
        if (opts.json) emitJson(plan);
        else process.stdout.write(renderPlan(plan));
        if (!plan.writable) setExitCode(1);
      } else {
        const result = await zip.create(spec);
        if (opts.json) emitJson(result);
        else process.stdout.write(renderResult(result));
      }
    } finally {
      await reporter.finalize();
    }
  });
}
