/**
 * The ZipKit SDK class. `plan()` scans and runs the pure planning pass,
 * writing nothing; `write()` executes a plan; `create()` does both. The
 * `plan → inspect → write` flow is the reason ZipKit is an SDK and not only a
 * CLI: a caller computes the plan, reads `findings`, decides, then writes. The
 * plan carries the resolved output and the overwrite intent, so `write(plan)`
 * is self-contained. The per-call policy is merged over the instance policy.
 */

import os from "node:os";
import pLimit from "p-limit";
import { ZipKitError } from "./errors.js";
import { buildMatcher } from "./filter/match.js";
import { createLogger } from "./log/logger.js";
import type { Logger } from "./log/logger.js";
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
import type {
  ArchivePolicy,
  ArchiveSpec,
  CreateData,
  ExtractData,
  ExtractSpec,
  LogEvent,
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
  readonly #policy: Partial<ArchivePolicy> | undefined;
  readonly #concurrency: number;
  readonly #chunkSize: number;

  constructor(options: ZipKitOptions = {}) {
    this.#policy = options.policy ? validatePolicy(options.policy) : undefined;
    this.#concurrency =
      options.concurrency !== undefined
        ? validateConcurrency(options.concurrency)
        : defaultConcurrency();
    this.#chunkSize =
      options.chunkSize !== undefined ? validateChunkSize(options.chunkSize) : DEFAULT_CHUNK_SIZE;
  }

  /** Scan and plan; writes nothing. Returns the `mode:"plan"` payload. */
  async plan(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<PlanData> {
    const logger = createLogger(options.onProgress);
    return this.#plan(spec, logger, options.signal);
  }

  /** Execute a plan produced by {@link ZipKit.plan}. */
  async write(plan: PlanData, options: ZipKitCallOptions = {}): Promise<WriteData> {
    const logger = createLogger(options.onProgress);
    return this.#runWrite(plan, { logger, chunkSize: this.#chunkSize, signal: options.signal });
  }

  /** Plan and write in one call. One logger and one signal serve both inner
   *  steps, so the caller's single `onProgress` hook sees the whole run and one
   *  cancellation stops it at whichever phase it is in. */
  async create(spec: ArchiveSpec, options: ZipKitCallOptions = {}): Promise<WriteData> {
    const logger = createLogger(options.onProgress);
    const plan = await this.#plan(spec, logger, options.signal);
    return this.#runWrite(plan, { logger, chunkSize: this.#chunkSize, signal: options.signal });
  }

  /**
   * Read an archive: verify every entry's CRC-32, optionally reconcile against
   * the manifest (`checkMetadata`) and verify recorded SHA-256s, and — unless
   * `dryRun` is set — write the verified entries to `dest`. A dry run writes
   * nothing and is a pure integrity test that works on any ZIP.
   */
  async extract(spec: ExtractSpec, options: ZipKitCallOptions = {}): Promise<ExtractData> {
    const logger = createLogger(options.onProgress);
    try {
      const validated = validateExtractSpec(spec);
      const limit = pLimit(this.#concurrency);
      return await extractArchive(validated, {
        limit,
        logger,
        chunkSize: this.#chunkSize,
        signal: options.signal,
      });
    } catch (err) {
      this.#reportError(logger, err);
      throw err;
    }
  }

  /** The shared plan path. `plan()` and `create()` both route through it with
   *  the logger and signal from their own call's options. */
  async #plan(spec: ArchiveSpec, logger: Logger, signal: AbortSignal | undefined): Promise<PlanData> {
    try {
      const validated = validateSpec(spec);
      const policy = resolvePolicy(this.#policy, validated.policy);
      const matcher = buildMatcher(policy.filters, policy.junk === "builtin");
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
    plan: PlanData,
    deps: { logger: Logger; chunkSize: number; signal?: AbortSignal },
  ): Promise<WriteData> {
    try {
      return await writeArchive(plan, deps);
    } catch (err) {
      this.#reportError(deps.logger, err);
      throw err;
    }
  }

  /** Emit a terminal error event so a `--log` JSONL trail (and any SDK logger)
   *  records the failure instead of going silent mid-stream. Best-effort: the
   *  logger swallows its own faults, and the original error is always rethrown
   *  by the caller. */
  #reportError(logger: Logger, err: unknown): void {
    const code = err instanceof ZipKitError ? err.code : "unknown";
    const stage: LogEvent["stage"] = code.startsWith("scan.")
      ? "scan"
      : code.startsWith("write.")
        ? "write"
        : code.startsWith("read.")
          ? "extract"
          : "plan";
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    logger.emit(stage, "error", message, {
      data: cause !== undefined ? { code, cause } : { code },
    });
  }

  #reportPlan(logger: Logger, plan: PlanData): void {
    for (const entry of plan.entries) {
      if (entry.excluded) {
        logger.emit("plan", "debug", "entry.excluded", {
          path: entry.archivePath,
          data: entry.excludeReason !== undefined ? { reason: entry.excludeReason } : undefined,
        });
      } else if (entry.archivePath !== entry.originalPath) {
        logger.emit("plan", "debug", "entry.renamed", {
          path: entry.archivePath,
          data: { from: entry.originalPath },
        });
      }
    }
    for (const f of plan.findings) {
      const level = f.severity === "error" ? "error" : f.severity === "warning" ? "warn" : "info";
      logger.emit("plan", level, "entry.flagged", {
        rule: f.rule,
        path: f.path,
        data: { severity: f.severity },
      });
    }
    logger.emit("plan", "info", "plan.done", {
      data: {
        total: plan.summary.total,
        included: plan.summary.included,
        excluded: plan.summary.excluded,
        renamed: plan.summary.renamed,
        warnings: plan.summary.warnings,
        errors: plan.summary.errors,
        writable: plan.writable,
      },
    });
  }
}
