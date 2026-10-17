/**
 * The ZipKit SDK class. `plan()` scans and runs the pure planning pass,
 * writing nothing; `write()` executes a plan; `create()` does both. The
 * `plan → inspect → write` flow is the heart of the SDK: a caller computes the
 * plan, reads `findings`, decides, then writes. The
 * plan carries the resolved output and the overwrite intent, so `write(plan)`
 * is self-contained. The per-call policy is merged over the instance policy.
 *
 * **One instance is one logging session.** An instance given a `logDir` opens a
 * single per-session log — `<logDir>/yyyymmdd-hhmmss-utc-<id>.log`, JSON Lines —
 * lazily on its first verb call, and every verb on the instance appends its
 * events there; each result's `log` field names the file. Lines are appended
 * synchronously, so there is no descriptor to close and nothing to flush. An
 * instance without a `logDir` writes no file and its results' `log` is `null`;
 * its events reach only each call's `onProgress`, for a caller that records
 * them itself. The SDK reads no environment variables, writes nothing outside
 * the paths it is given, and writes nothing to stdout or stderr — progress goes
 * only to a per-call `onProgress` hook.
 * A log-sink failure is deliberately silent so logging cannot break a verb.
 *
 * The session spans the instance's lifetime: a caller that builds one `ZipKit`
 * per run gets a log that is exactly that run. A long-lived or shared instance
 * keeps appending to the one file (logs are never rotated), and verbs invoked
 * concurrently on the same instance interleave their lines. Construct a fresh
 * `ZipKit` per logical run when you want one self-contained session log.
 */

import os from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import { ZipKitError, type ZipKitErrorType } from "./errors.js";
import { matcherFor } from "./filter/match.js";
import { reportFindings } from "./log/findings.js";
import { createLogger, type LogSink } from "./log/logger.js";
import type { Logger } from "./log/logger.js";
import {
  openSessionLog,
  sessionLogName,
  type SessionLog,
} from "./log/session.js";
import { compareWithManifest } from "./compare/sources.js";
import { extractArchive, readManifest } from "./extract/extract.js";
import { readInternals } from "./internal/carrier.js";
import { classifyPaths, pathState } from "./paths.js";
import { checkRemoval, outputInsideInputs } from "./removal.js";
import { pathResources, type PathResource } from "./claims.js";
import { listArchive, readArchiveManifest } from "./extract/list.js";
import { nodeFileSystem, Volume } from "./internal/volume.js";
import { planArchive } from "./plan/plan.js";
import { METADATA_DEFAULTS, resolvePolicy } from "./policy.js";
import { scan } from "./scan/scan.js";
import {
  validateChunkSize,
  validateConcurrency,
  validateExtractSpec,
  validateIoTimeout,
  validatePolicy,
  validateDebug,
  validateLogDir,
  validateSkipPaths,
  validateSpec,
} from "./validate.js";
import { writeArchive, type WriteDeps } from "./write/write.js";
import { VERSION } from "./version.js";
import type { Unlogged } from "./internal/types.js";
import type {
  ArchiveListing,
  ArchivePolicy,
  ArchiveSpec,
  CreateData,
  DeepPartial,
  ExtractData,
  ExtractSpec,
  LogStage,
  Metadata,
  SourceComparison,
  PathEntry,
  PathState,
  RemovalCheck,
  RemovalOptions,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.js";

/** The `mode:"plan"` member of {@link CreateData}: what `plan()` returns and
 *  `write()` consumes (it also carries the writer's instructions out of band). */
export type PlanData = Extract<CreateData, { mode: "plan" }>;

/** The `mode:"write"` member of {@link CreateData}: what `write()`/`create()`
 *  return on success. */
export type WriteData = Extract<CreateData, { mode: "write" }>;

/**
 * The default concurrency tracks the host's available parallelism (which
 * respects cgroup and CPU-affinity limits, so it does the right thing in CI and
 * containers), bounded at both ends. All streamed I/O is now chunked, so an
 * in-flight entry holds only about `chunkSize` of buffer rather than its whole
 * file; peak memory is therefore roughly `chunkSize × concurrency`. The cap
 * keeps a many-core box from opening an unbounded number of streams at once.
 * The floor keeps the work — which is largely I/O-bound — parallel even on a
 * single-vCPU container, where `availableParallelism()` returns 1. Concurrency
 * governs the scan and extraction (each entry streams to its own output file);
 * the create write is a single ordered byte stream and runs sequentially.
 */
const MIN_DEFAULT_CONCURRENCY = 4;
const MAX_DEFAULT_CONCURRENCY = 16;

/** Default chunk size (64 KB) for all streamed I/O — see {@link ZipKitOptions.chunkSize}. */
const DEFAULT_CHUNK_SIZE = 65536;

/**
 * Default per-operation filesystem budget — see {@link ZipKitOptions.ioTimeoutMs}.
 * One operation moves at most a chunk, so on any working volume it settles in
 * well under a second; 30 s leaves room for a sleeping network drive or a disk
 * spinning up while still ending a job on a volume that has gone away.
 */
const DEFAULT_IO_TIMEOUT_MS = 30_000;

function defaultConcurrency(): number {
  return Math.max(MIN_DEFAULT_CONCURRENCY, Math.min(os.availableParallelism(), MAX_DEFAULT_CONCURRENCY));
}

export class ZipKit {
  readonly #policy: DeepPartial<ArchivePolicy> | undefined;
  readonly #concurrency: number;
  readonly #chunkSize: number;
  readonly #ioTimeoutMs: number;
  /** This session's log path, stamped at construction (the session start);
   *  `null` when the instance was built without a `logDir`. */
  readonly #sessionPath: string | null;
  /** The session log, opened lazily on the first verb call and reused so its
   *  directory is created once and its degrade state is shared across verbs. */
  #session: SessionLog | undefined;
  /** Whether the once-per-session startup line has been emitted yet. */
  #startupLogged = false;
  /** Whether `debug` events reach the sinks. */
  readonly #debug: boolean;
  /** Folders a scan leaves out entirely. */
  readonly #skipPaths: readonly string[];

  constructor(options: ZipKitOptions = {}) {
    this.#policy = options.policy ? validatePolicy(options.policy) : undefined;
    this.#concurrency =
      options.concurrency !== undefined
        ? validateConcurrency(options.concurrency)
        : defaultConcurrency();
    this.#chunkSize =
      options.chunkSize !== undefined ? validateChunkSize(options.chunkSize) : DEFAULT_CHUNK_SIZE;
    this.#ioTimeoutMs =
      options.ioTimeoutMs !== undefined ? validateIoTimeout(options.ioTimeoutMs) : DEFAULT_IO_TIMEOUT_MS;
    const logDir = validateLogDir(options.logDir);
    this.#sessionPath = logDir === null ? null : path.join(logDir, sessionLogName());
    this.#debug = validateDebug(options.debug);
    this.#skipPaths = validateSkipPaths(options.skipPaths);
  }

  /**
   * Scan and plan; writes nothing. Returns the `mode:"plan"` payload, which is a
   * **live handle**: pass the *same* object to {@link ZipKit.write}. It is safe to
   * inspect and `JSON.stringify` (its only absolute paths are `output` and each
   * entry's `diskPath`), but the
   * writer's instructions ride on it out of band, so a cloned or re-serialized
   * copy cannot be written — inspect freely, but write from the original.
   */
  async plan(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<PlanData> {
    return this.#run(options, (logger) => this.#plan(spec, logger, options.signal, this.volume(options.signal)));
  }

  /** Execute a plan produced by {@link ZipKit.plan}. Must be the exact object
   *  `plan()` returned — not a clone or a re-serialized copy, which drops the
   *  out-of-band writer instructions and fails with `write.no-internals`. */
  async write(plan: PlanData, options: ZipKitCallOptions = {}): Promise<WriteData> {
    const volume = this.volume(options.signal);
    try {
      return await this.#run(options, (logger) => this.#runWrite(plan, {
        logger, chunkSize: this.#chunkSize, signal: options.signal, volume, onCounts: options.onCounts,
      }));
    } finally { this.#notifySettlement(options, volume); }
  }

  /** Plan and write in one call. One logger and one signal serve both inner
   *  steps, so the caller's single `onProgress` hook sees the whole run and one
   *  cancellation stops it at whichever phase it is in. */
  async create(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<WriteData> {
    const volume = this.volume(options.signal);
    try {
      return await this.#run(options, async (logger) => {
        const plan = await this.#plan(spec, logger, options.signal, volume);
        return this.#runWrite(plan, { logger, chunkSize: this.#chunkSize, signal: options.signal, volume, onCounts: options.onCounts });
      });
    } finally { this.#notifySettlement(options, volume); }
  }

  #notifySettlement(options: ZipKitCallOptions, volume: Volume): void {
    // Capture after logical cleanup: an earlier empty set could report idle
    // before the first write, or omit continuations spawned by late calls.
    try { options.onPhysicalSettlement?.(volume.whenSettled()); }
    catch { /* Like a progress sink, the observer cannot break the verb. */ }
  }

  /**
   * Read an archive: verify every entry's CRC-32, optionally reconcile against
   * the manifest (`checkMetadata`) and verify recorded SHA-256s, and — unless
   * `dryRun` is set — write the verified entries to `dest`. A dry run writes
   * nothing and is a pure integrity test that works on any ZIP.
   */
  async extract(spec: ExtractSpec, options: ZipKitCallOptions = {}): Promise<ExtractData> {
    return this.#run(options, async (logger) => {
      try {
        const validated = validateExtractSpec(spec);
        const limit = pLimit(this.#concurrency);
        return await extractArchive(validated, {
          limit,
          chunkSize: this.#chunkSize,
          logger,
          signal: options.signal,
          volume: this.volume(options.signal),
          onCounts: options.onCounts,
        });
      } catch (err) {
        this.#reportError(logger, err);
        throw err;
      }
    });
  }

  /**
   * Re-scan `spec`'s inputs and compare them with the manifest embedded in
   * `archive` (see {@link SourceComparison}), the check before deleting the
   * originals an archive was made from. `spec` is the one the archive was
   * created with, so the same entries are included and excluded. Writes
   * nothing; emits the scan's events but not a plan's findings, since this
   * plan is never written.
   */
  async compareSources(
    spec: ArchiveSpec,
    archive: string,
    options: ZipKitCallOptions = {},
  ): Promise<SourceComparison> {
    const result = await this.#run(options, async (logger) => {
      try {
        const validated = validateSpec(spec);
        const policy = resolvePolicy(this.#policy, validated.policy);
        const volume = this.volume(options.signal);
        const limit = pLimit(this.#concurrency);
        const scanned = await scan(validated, policy, {
          matcher: matcherFor(policy),
          limit,
          logger,
          signal: options.signal,
          volume,
          skipPaths: this.#skipPaths,
        });
        const plan = planArchive(scanned, policy);
        const name = policy.metadata !== false ? policy.metadata.name : METADATA_DEFAULTS.name;
        const records = await readManifest(volume, archive, name);
        const unlistedDirs = new Set(scanned.unlistedDirs);
        const unlisted = scanned.entries
          .filter((e) => e.type === "dir" && unlistedDirs.has(e.archivePath))
          .map((e) => e.sourcePath);
        return compareWithManifest(readInternals(plan)?.writeEntries ?? [], unlisted, records);
      } catch (err) {
        this.#reportError(logger, err);
        throw err;
      }
    });
    const { log: _log, ...comparison } = result;
    return comparison;
  }

  /**
   * The entries of `archive` as its central directory records them, without
   * reading their data: what `extract` would verify. Works on any ZIP. A time
   * stored only in the DOS field, which carries no zone, is read in
   * `timeZone` (the host's by default). Bounded like every look at a user volume.
   */
  list(archive: string, options: Pick<ZipKitCallOptions, "signal"> & { timeZone?: string } = {}): Promise<ArchiveListing> {
    return listArchive(this.volume(options.signal), archive, options.timeZone);
  }

  /**
   * The manifest ZipKit embedded in `archive`, read whole: the policy, the
   * summary, every entry with its source trace, size, times and hashes, what
   * was left out and why. `name` is the manifest's name when the archive was
   * made with another (`zipkit.json` by default). Holds the whole document, so
   * to check a very large archive against its manifest use `extract` with
   * `checkMetadata`, which streams it.
   */
  readManifest(archive: string, options: Pick<ZipKitCallOptions, "signal"> & { name?: string } = {}): Promise<Metadata> {
    return readArchiveManifest(this.volume(options.signal), archive, options.name);
  }

  /**
   * Whether the originals `archive` was made from can be removed without
   * losing data, checked in order: the archive is the one expected (when
   * `fingerprint` is given), it does not sit at or inside an input, it
   * verifies against its manifest, and a fresh scan of `spec`'s inputs still
   * matches that manifest. `spec` is the one the archive was created with,
   * its inputs only those still to be removed. Removes nothing; a check that
   * cannot finish refuses, naming its step, rather than throwing.
   */
  async checkRemoval(spec: ArchiveSpec, archive: string, options: RemovalOptions = {}): Promise<RemovalCheck> {
    const { removed = [], fingerprint, ...call } = options;
    // The archive is the output, so the fresh scan never counts the archive
    // itself when it sits beside the inputs.
    const { outputDir: _dir, outputName: _name, ...rest } = spec;
    const rescan: ArchiveSpec = { ...rest, output: archive };
    return checkRemoval({
      state: () => this.pathState(archive, call),
      inside: () => outputInsideInputs(archive, spec.inputs, this.volume(call.signal)),
      verify: async () => (await this.extract({ archive, dryRun: true, checkMetadata: true }, call)).reportOk,
      compare: () => this.compareSources(rescan, archive, call),
    }, spec.inputs, removed, fingerprint);
  }

  /**
   * The SDK's bounded file access, for a caller that must touch the same user
   * volumes outside a verb (checking an input or an output location). Each call
   * is bounded by this instance's `ioTimeoutMs` and answers to `signal`, and
   * fails with a `StallError` naming the path when the volume stops responding.
   */
  volume(signal?: AbortSignal): Volume {
    return new Volume(nodeFileSystem, this.#ioTimeoutMs, signal);
  }

  /**
   * What is at a path now: there with a fingerprint, gone, or out of reach on a
   * drive that is not connected or a path that cannot be read. Compare two
   * fingerprints with `sameFile` to tell a file rewritten in place from another
   * file put in its place. Bounded like every look at a user volume.
   */
  pathState(target: string, options: Pick<ZipKitCallOptions, "signal"> = {}): Promise<PathState> {
    return pathState(target, this.volume(options.signal));
  }

  /** Each path as a path claim compares it (see `createPathClaims`), resolved
   *  through links and folder aliases; a path that is a link to a file also
   *  yields the file it points to. Bounded like every look at a user volume. */
  pathResources(paths: readonly string[], options: Pick<ZipKitCallOptions, "signal"> = {}): Promise<PathResource[]> {
    return pathResources(paths, this.volume(options.signal));
  }

  /** What each path is on disk now, in order (see `PathKind`). */
  classify(paths: readonly string[], options: Pick<ZipKitCallOptions, "signal"> = {}): Promise<PathEntry[]> {
    return classifyPaths(paths, this.volume(options.signal));
  }

  /** The instance's session log, opened lazily on first use so an instance that
   *  never runs a verb writes no file. */
  #sessionLog(sessionPath: string): SessionLog {
    if (this.#session === undefined) this.#session = openSessionLog(sessionPath);
    return this.#session;
  }

  /**
   * The one seam every verb runs through. Builds the run's logger from the two
   * sinks a run has — the session log (when there is a `logDir`) and the
   * optional per-call `onProgress` hook — runs the verb, then stamps the
   * session-log path (or `null`) onto the result the boundary owns. The stamp is
   * a mutation, not a spread: a {@link PlanData} carries non-enumerable writer
   * instructions (`src/internal/carrier.ts`) that an object spread would
   * silently drop.
   */
  async #run<U extends object>(
    options: ZipKitCallOptions,
    fn: (logger: Logger) => Promise<U>,
  ): Promise<U & { log: string | null }> {
    const sinks: LogSink[] = [];
    if (this.#sessionPath !== null) sinks.push(this.#sessionLog(this.#sessionPath).sink);
    if (options.onProgress) sinks.push(options.onProgress);
    const logger = createLogger(sinks, this.#debug);
    // Startup line, once per session: the tool version and the effective runtime
    // configuration, so a session log is always tied to a version and the knobs
    // it ran with (the logging convention's startup-coverage rule).
    if (!this.#startupLogged) {
      this.#startupLogged = true;
      logger.emit({
        stage: "session",
        level: "info",
        event: "session.start",
        version: VERSION,
        concurrency: this.#concurrency,
        chunkSize: this.#chunkSize,
      });
    }
    const result = (await fn(logger)) as U & { log: string | null };
    result.log = this.#sessionPath;
    return result;
  }

  /** The shared plan path. `plan()` and `create()` both route through it with
   *  the logger and signal from their own call's options. */
  async #plan(
    spec: ArchiveSpec,
    logger: Logger,
    signal: AbortSignal | undefined,
    volume: Volume,
  ): Promise<Unlogged<PlanData>> {
    try {
      const validated = validateSpec(spec);
      const policy = resolvePolicy(this.#policy, validated.policy);
      const matcher = matcherFor(policy);
      const limit = pLimit(this.#concurrency);

      const scanResult = await scan(validated, policy, { matcher, limit, logger, signal, volume, skipPaths: this.#skipPaths });
      const plan = planArchive(scanResult, policy);
      this.#reportPlan(logger, plan);
      return plan;
    } catch (err) {
      this.#reportError(logger, err);
      throw err;
    }
  }

  /** Execute the writer, reporting any failure to the log stream before it
   *  propagates. `#plan()` reports its own failures, so `create()` does not
   *  double-report when its inner plan throws. */
  async #runWrite(
    plan: Unlogged<PlanData>,
    deps: WriteDeps,
  ): Promise<Unlogged<WriteData>> {
    try {
      return await writeArchive(plan, deps);
    } catch (err) {
      this.#reportError(deps.logger, err);
      throw err;
    }
  }

  /** Emit a terminal error event so the session log (and any `onProgress` hook)
   *  records the failure instead of going silent mid-stream. Best-effort: the
   *  logger swallows its own faults, and the original error is always rethrown
   *  by the caller. The stage comes from the fault's `errorType` — the typed
   *  error's own domain, never a code-string prefix — so the log stage and the
   *  error a caller branches on can never disagree. */
  #reportError(logger: Logger, err: unknown): void {
    const stage: LogStage = err instanceof ZipKitError ? STAGE_FOR_ERROR_TYPE[err.errorType] : "plan";
    const code = err instanceof ZipKitError ? err.code : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    logger.emit(
      cause !== undefined
        ? { stage, level: "error", event: "fault", code, detail: message, cause }
        : { stage, level: "error", event: "fault", code, detail: message },
    );
  }

  #reportPlan(logger: Logger, plan: Unlogged<PlanData>): void {
    for (const entry of plan.entries) {
      if (entry.excluded) {
        logger.emit(
          entry.excludeReason !== undefined
            ? { stage: "plan", level: "debug", event: "entry.excluded", path: entry.archivePath, reason: entry.excludeReason }
            : { stage: "plan", level: "debug", event: "entry.excluded", path: entry.archivePath },
        );
      } else if (entry.archivePath !== entry.originalPath) {
        logger.emit({
          stage: "plan",
          level: "debug",
          event: "entry.renamed",
          path: entry.archivePath,
          from: entry.originalPath,
        });
      }
    }
    reportFindings(logger, "plan", plan.findings);
    logger.emit({
      stage: "plan",
      level: "info",
      event: "plan.done",
      total: plan.summary.total,
      included: plan.summary.included,
      excluded: plan.summary.excluded,
      renamed: plan.summary.renamed,
      warnings: plan.summary.warnings,
      errors: plan.summary.errors,
      writable: plan.writable,
    });
  }
}

/** Map a fault's domain (`errorType`) to the log stage its terminal event is
 *  recorded under. Keyed off the typed error's domain — never a code-string
 *  prefix — so the two views of a fault stay in agreement. */
const STAGE_FOR_ERROR_TYPE: Record<ZipKitErrorType, LogStage> = {
  scan: "scan",
  policy: "plan",
  write: "write",
  read: "extract",
  abort: "plan",
  stall: "plan",
};
