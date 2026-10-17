/**
 * The `zipkit` command: plan, create, verify and list archives from a shell.
 * It is the SDK's second consumer beside the desktop app and imports only the
 * SDK's public entry, so anything it needs and cannot reach is a gap in the
 * SDK. `run` takes the arguments and the streams and resolves to the exit
 * code, so tests drive it in-process; `./zipkit.ts` is the executable.
 */

import { parseArgs } from "node:util";
import {
  VERSION,
  ZipKit,
  ZipKitError,
  type ArchiveSpec,
  type DeepPartial,
  type ArchivePolicy,
  type Finding,
  type NameAction,
  type PlanData,
  type ProgressCounts,
} from "../index.js";

/** Where the command writes, and whether its error stream is a terminal that
 *  can show a progress line. */
export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown; isTTY?: boolean };
  signal?: AbortSignal;
}

/** The exit codes: what a script branches on. */
export const EXIT = {
  ok: 0,
  /** The plan blocks the write, or the archive does not verify. */
  refused: 1,
  usage: 2,
  policy: 3,
  scan: 4,
  write: 5,
  read: 6,
  stall: 7,
  aborted: 130,
} as const;

const HELP = `Usage: zipkit <command> [options]

Commands:
  plan <input>...      Show what an archive of the inputs would hold; writes nothing.
  create <input>...    Make the archive, if the plan finds nothing that blocks it.
  verify <archive>     Check every entry's CRC-32 and the embedded manifest.
  list <archive>       List an archive's entries without verifying them.

Archive options (plan, create):
  -o, --output <file>      The archive's path (default: beside the inputs).
      --output-dir <dir>   The folder the archive goes in.
      --name <name>        The archive's file name.
      --overwrite          Replace an existing archive.
      --exclude <glob>     Leave out what matches; repeatable.
      --no-junk            Keep OS junk files such as .DS_Store.
      --names <action>     fix, warn, error or none, for every name rule.
      --symlinks <mode>    ignore, preserve or follow.
      --no-manifest        Embed no zipkit.json manifest.
      --no-hash            Record no SHA-256 in the manifest.
      --comment <text>     The archive comment.

Verify options:
      --crc-only           Check CRC-32 only, for an archive without a manifest.

Common options:
      --json               Print the result as JSON.
  -q, --quiet              Print no progress or summary.
  -h, --help               Show this help.
  -v, --version            Show the version.

Exit codes: 0 done, 1 refused (blocked plan or failed verification), 2 usage,
3 policy, 4 scan, 5 write, 6 read, 7 stalled volume, 130 cancelled.
`;

const OPTIONS = {
  output: { type: "string", short: "o" },
  "output-dir": { type: "string" },
  name: { type: "string" },
  overwrite: { type: "boolean" },
  exclude: { type: "string", multiple: true },
  "no-junk": { type: "boolean" },
  names: { type: "string" },
  symlinks: { type: "string" },
  "no-manifest": { type: "boolean" },
  "no-hash": { type: "boolean" },
  comment: { type: "string" },
  "crc-only": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

const NAME_ACTIONS: readonly NameAction[] = ["fix", "warn", "error", "none"];
const SYMLINK_MODES: readonly ArchivePolicy["symlinks"][] = ["ignore", "preserve", "follow"];

/** The spec the archive options describe. */
function specFrom(inputs: string[], values: Values): ArchiveSpec {
  if (inputs.length === 0) throw new UsageError("give at least one input");
  const spec: ArchiveSpec = { inputs };
  if (values.output !== undefined) spec.output = values.output;
  if (values["output-dir"] !== undefined) spec.outputDir = values["output-dir"];
  if (values.name !== undefined) spec.outputName = values.name;
  if (values.overwrite) spec.overwrite = true;
  if (values.comment !== undefined) spec.comment = values.comment;
  const policy: DeepPartial<ArchivePolicy> = {};
  if (values.exclude) policy.filters = values.exclude.map((pattern) => ({ pattern, match: "glob", target: "both" }));
  if (values["no-junk"]) policy.junk = "none";
  if (values.names !== undefined) {
    const action = values.names as NameAction;
    if (!NAME_ACTIONS.includes(action)) throw new UsageError(`--names takes ${NAME_ACTIONS.join(", ")}`);
    // `suspicious` names are only ever flagged, so `fix` leaves them as they are.
    const suspicious = action === "fix" ? undefined : action;
    policy.names = { nfc: action, invalidChars: action, controlChars: action, trailingDotSpace: action, reserved: action, ...(suspicious ? { suspicious } : {}) };
  }
  if (values.symlinks !== undefined) {
    const mode = values.symlinks as ArchivePolicy["symlinks"];
    if (!SYMLINK_MODES.includes(mode)) throw new UsageError(`--symlinks takes ${SYMLINK_MODES.join(", ")}`);
    policy.symlinks = mode;
  }
  if (values["no-manifest"]) policy.metadata = false;
  else if (values["no-hash"]) policy.metadata = { hash: false };
  if (Object.keys(policy).length > 0) spec.policy = policy;
  return spec;
}

/** A size in decimal units, as the Finder and the app write it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** One line on a terminal's error stream, redrawn as counts arrive. */
function progressLine(io: CliIo, quiet: boolean): { onProgress?: (counts: ProgressCounts) => void; done(): void } {
  if (quiet || !io.stderr.isTTY) return { done() {} };
  let drawn = false;
  return {
    onProgress(counts) {
      const verb = counts.stage === "write" ? "Writing" : "Verifying";
      io.stderr.write(`\r\x1b[K${verb} ${counts.entriesDone}/${counts.entriesTotal} items · ${formatBytes(counts.bytesDone)}/${formatBytes(counts.bytesTotal)}`);
      drawn = true;
    },
    done() { if (drawn) io.stderr.write("\r\x1b[K"); },
  };
}

const plural = (count: number, one: string, other = `${one}s`): string => `${count} ${count === 1 ? one : other}`;

/** What a plan found, the blocking first; notes only as a count. */
function describePlan(plan: PlanData): string {
  const s = plan.summary;
  const lines = [
    `Archive: ${plan.output}`,
    `Items: ${s.included} included, ${s.excluded} excluded, ${s.renamed} renamed (${formatBytes(s.sourceBytes)})`,
  ];
  const shown = (severity: Finding["severity"]) => plan.findings.filter((f) => f.severity === severity);
  for (const f of [...shown("error"), ...shown("warning")]) lines.push(`  ${f.severity.padEnd(7)} ${f.rule}  ${f.path}  ${f.message}`);
  // Notes (fixed names, junk left out) only as counts per rule; --json has each.
  const notes = new Map<string, number>();
  for (const f of shown("info")) notes.set(f.rule, (notes.get(f.rule) ?? 0) + 1);
  if (notes.size > 0) lines.push(`  notes   ${[...notes].map(([rule, count]) => `${rule} ×${count}`).join(", ")}`);
  lines.push(plan.writable ? "Writable: yes" : `Writable: no, ${plural(s.errors, "finding")} block the archive`);
  return `${lines.join("\n")}\n`;
}

function exitFor(error: unknown): number {
  if (!(error instanceof ZipKitError)) return EXIT.write;
  return {
    policy: EXIT.policy,
    scan: EXIT.scan,
    write: EXIT.write,
    read: EXIT.read,
    stall: EXIT.stall,
    abort: EXIT.aborted,
  }[error.errorType];
}

/** Run the command; resolves to its exit code and never throws. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr.write(`zipkit: ${(error as Error).message}\n\n${HELP}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.version) { io.stdout.write(`${VERSION}\n`); return EXIT.ok; }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) { (command === undefined && !values.help ? io.stderr : io.stdout).write(HELP); return command === undefined && !values.help ? EXIT.usage : EXIT.ok; }

  const zip = new ZipKit();
  const signal = io.signal;
  const quiet = values.quiet === true;
  const json = values.json === true;
  const print = (value: unknown, text: string): void => {
    if (json) io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else if (!quiet) io.stdout.write(text);
  };
  const progress = progressLine(io, quiet || json);
  try {
    switch (command) {
      case "plan": {
        const plan = await zip.plan(specFrom(rest, values), { signal });
        print(plan, describePlan(plan));
        return plan.writable ? EXIT.ok : EXIT.refused;
      }
      case "create": {
        const plan = await zip.plan(specFrom(rest, values), { signal });
        if (!plan.writable) {
          print(plan, describePlan(plan));
          return EXIT.refused;
        }
        const written = await zip.write(plan, { signal, ...(progress.onProgress ? { onProgress: progress.onProgress } : {}) });
        progress.done();
        print(written, `${describePlan(plan)}Wrote ${written.output} (${formatBytes(written.bytes ?? 0)})\n`);
        return EXIT.ok;
      }
      case "verify": {
        const [archive, ...extra] = rest;
        if (archive === undefined || extra.length > 0) throw new UsageError("verify takes one archive");
        const checkMetadata = values["crc-only"] !== true;
        const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { signal, ...(progress.onProgress ? { onProgress: progress.onProgress } : {}) });
        progress.done();
        const problems = data.findings.filter((f) => f.severity === "error");
        const text = data.reportOk
          ? `OK: ${plural(data.summary.total, "entry", "entries")} verified${checkMetadata ? " against the manifest" : ""}\n`
          : `${problems.map((f) => `  ${f.rule}  ${f.path}  ${f.message}`).join("\n")}\nFailed: ${plural(problems.length, "problem")} in ${archive}\n`;
        print(data, text);
        return data.reportOk ? EXIT.ok : EXIT.refused;
      }
      case "list": {
        const [archive, ...extra] = rest;
        if (archive === undefined || extra.length > 0) throw new UsageError("list takes one archive");
        const listing = await zip.list(archive, { signal });
        print(listing, listing.entries.map((e) =>
          `${(e.type === "dir" ? "-" : formatBytes(e.size)).padStart(9)}  ${e.modified.iso.slice(0, 19).replace("T", " ")}  ${e.archivePath}${e.type === "dir" ? "/" : ""}`,
        ).join("\n") + (listing.entries.length > 0 ? "\n" : ""));
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    progress.done();
    if (error instanceof UsageError) {
      io.stderr.write(`zipkit: ${error.message}\n\n${HELP}`);
      return EXIT.usage;
    }
    const code = error instanceof ZipKitError ? ` (${error.code})` : "";
    io.stderr.write(`zipkit: ${(error as Error).message}${code}\n`);
    return exitFor(error);
  }
}
