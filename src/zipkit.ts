/**
 * The ZipKit SDK class. `plan()` scans and runs the pure planning pass,
 * writing nothing; `write()` executes a plan; `create()` does both. The
 * `plan → inspect → write` flow is the reason ZipKit is an SDK and not only a
 * CLI: a caller computes the plan, reads `findings`, decides, then writes. The
 * plan carries the resolved output and the overwrite intent, so `write(plan)`
 * is self-contained. The per-call policy is merged over the instance policy.
 *
 * **One instance is one logging session.** Each instance opens a single
 * per-session log — `<logDir>/yyyymmdd-hhmmss-fff-utc.log`, JSON Lines — lazily
 * on its first verb call, and every verb on the instance appends its events
 * there; each result's `log` field names the file. `logDir` defaults to
 * `ZIPKIT_LOG_DIR`, else `~/.zipkit/logs`. Lines are appended synchronously, so
 * there is no descriptor to close and nothing to flush. The SDK writes nothing
 * to stdout or stderr — progress goes only to a per-call `onProgress` hook —
 * except the console fallback the log uses if its file becomes unwritable.
 *
 * The session spans the instance's lifetime: the CLI builds one `ZipKit` per
 * invocation, so its log is exactly that run. A long-lived or shared instance
 * keeps appending to the one file (logs are never rotated), and verbs invoked
 * concurrently on the same instance interleave their lines. Construct a fresh
 * `ZipKit` per logical run when you want one self-contained session log.
 */

import os from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import { ZipKitError, type ZipKitErrorType } from "./errors.js";
import { matcherFor } from "./filter/match.js";
import { createLogger, type LogSink } from "./log/logger.js";
import type { Logger } from "./log/logger.js";
import {
  defaultLogDir,
  defaultSessionTimestamp,
  openSessionLog,
  type SessionLog,
} from "./log/session.js";
import { extractArchive } from "./extract/extract.js";
import { planArchive } from "./plan/plan.js";
import { resolvePolicy } from "./policy.js";
import { scan } from "./scan/scan.js";
import {
  validateChunkSize,
  validateConcurrency,
  validateExtractSpec,
  validatePolicy,
  validateSpec,
} from "./validate.js";
import { writeArchive } from "./write/write.js";
import type { Unlogged } from "./internal/types.js";
import type {
  ArchivePolicy,
  ArchiveSpec,
  CreateData,
  DeepPartial,
  ExtractData,
  ExtractSpec,
  LogStage,
  ZipKitCallOptions,
  ZipKitOptions,
} from "./types.js";

/** The `mode:"plan"` member of {@link CreateData}: what `plan()` returns and
 *  `write()` consumes (it also carries the writer's instructions out of band). */
type PlanData = Extract<CreateData, { mode: "plan" }>;

/** The `mode:"write"` member of {@link CreateData}: what `write()`/`create()`
 *  return on success. */
type WriteData = Extract<CreateData, { mode: "write" }>;

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

function defaultConcurrency(): number {
  return Math.max(MIN_DEFAULT_CONCURRENCY, Math.min(os.availableParallelism(), MAX_DEFAULT_CONCURRENCY));
}

export class ZipKit {
  readonly #policy: DeepPartial<ArchivePolicy> | undefined;
  readonly #concurrency: number;
  readonly #chunkSize: number;
  /** This session's log path, stamped at construction (the session start). */
  readonly #sessionPath: string;
  /** The session log, opened lazily on the first verb call and reused so its
   *  directory is created once and its degrade state is shared across verbs. */
  #session: SessionLog | undefined;

  constructor(options: ZipKitOptions = {}) {
    this.#policy = options.policy ? validatePolicy(options.policy) : undefined;
    this.#concurrency =
      options.concurrency !== undefined
        ? validateConcurrency(options.concurrency)
        : defaultConcurrency();
    this.#chunkSize =
      options.chunkSize !== undefined ? validateChunkSize(options.chunkSize) : DEFAULT_CHUNK_SIZE;
    const logDir = options.logDir ?? process.env.ZIPKIT_LOG_DIR ?? defaultLogDir();
    this.#sessionPath = path.join(logDir, `${defaultSessionTimestamp()}.log`);
  }

  /**
   * Scan and plan; writes nothing. Returns the `mode:"plan"` payload, which is a
   * **live handle**: pass the *same* object to {@link ZipKit.write}. It is safe to
   * inspect and `JSON.stringify` (it carries no absolute source paths), but the
   * writer's instructions ride on it out of band, so a cloned or re-serialized
   * copy cannot be written — inspect freely, but write from the original.
   */
  async plan(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<PlanData> {
    return this.#run(options, (logger) => this.#plan(spec, logger, options.signal));
  }

  /** Execute a plan produced by {@link ZipKit.plan}. Must be the exact object
   *  `plan()` returned — not a clone or a re-serialized copy, which drops the
   *  out-of-band writer instructions and fails with `write.no-internals`. */
  async write(plan: PlanData, options: ZipKitCallOptions = {}): Promise<WriteData> {
    return this.#run(options, (logger) =>
      this.#runWrite(plan, { logger, chunkSize: this.#chunkSize, signal: options.signal }),
    );
  }

  /** Plan and write in one call. One logger and one signal serve both inner
   *  steps, so the caller's single `onProgress` hook sees the whole run and one
   *  cancellation stops it at whichever phase it is in. */
  async create(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<WriteData> {
    return this.#run(options, async (logger) => {
      const plan = await this.#plan(spec, logger, options.signal);
      return this.#runWrite(plan, { logger, chunkSize: this.#chunkSize, signal: options.signal });
    });
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
        });
      } catch (err) {
        this.#reportError(logger, err);
        throw err;
      }
    });
  }

  /** The instance's session log, opened lazily on first use so an instance that
   *  never runs a verb writes no file. */
  #sessionLog(): SessionLog {
    if (this.#session === undefined) this.#session = openSessionLog(this.#sessionPath);
    return this.#session;
  }

  /**
   * The one seam every verb runs through. Builds the run's logger from the two
   * sinks a run has — the always-on session log and the optional per-call
   * `onProgress` hook — runs the verb, then stamps the session-log path onto the
   * result the boundary owns. The stamp is a mutation, not a spread: a
   * {@link PlanData} carries non-enumerable writer instructions
   * (`src/internal/carrier.ts`) that an object spread would silently drop.
   */
  async #run<U extends object>(
    options: ZipKitCallOptions,
    fn: (logger: Logger) => Promise<U>,
  ): Promise<U & { log: string }> {
    const sinks: LogSink[] = [this.#sessionLog().sink];
    if (options.onProgress) sinks.push(options.onProgress);
    const logger = createLogger(sinks);
    const result = (await fn(logger)) as U & { log: string };
    result.log = this.#sessionPath;
    return result;
  }

  /** The shared plan path. `plan()` and `create()` both route through it with
   *  the logger and signal from their own call's options. */
  async #plan(
    spec: ArchiveSpec,
    logger: Logger,
    signal: AbortSignal | undefined,
  ): Promise<Unlogged<PlanData>> {
    try {
      const validated = validateSpec(spec);
      const policy = resolvePolicy(this.#policy, validated.policy);
      const matcher = matcherFor(policy);
      const limit = pLimit(this.#concurrency);

      const scanResult = await scan(validated, policy, { matcher, limit, logger, signal });
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
    deps: { logger: Logger; chunkSize: number; signal?: AbortSignal },
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
   *  by the caller. The stage comes from the fault's `errorType` — the same axis
   *  the exit-code classifier reads — so the log stage and the exit code can
   *  never disagree. */
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
    for (const f of plan.findings) {
      const level = f.severity === "error" ? "error" : f.severity === "warning" ? "warn" : "info";
      logger.emit({
        stage: "plan",
        level,
        event: "entry.flagged",
        rule: f.rule,
        path: f.path,
        severity: f.severity,
      });
    }
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
 *  recorded under. Keyed off the same axis as the exit-code classifier — never a
 *  code-string prefix — so the two views of a fault stay in agreement. */
const STAGE_FOR_ERROR_TYPE: Record<ZipKitErrorType, LogStage> = {
  scan: "scan",
  policy: "plan",
  write: "write",
  read: "extract",
  abort: "plan",
};
