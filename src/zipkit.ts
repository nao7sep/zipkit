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
import { validateExtractSpec, validatePolicy, validateSpec } from "./validate.js";
import { writeArchive } from "./write/write.js";
import type {
  ArchivePolicy,
  ArchiveSpec,
  ExtractReport,
  ExtractSpec,
  LogEvent,
  Plan,
  WriteResult,
  ZipKitOptions,
} from "./types.js";

/**
 * The default concurrency tracks the host's available parallelism (which
 * respects cgroup and CPU-affinity limits, so it does the right thing in CI and
 * containers), bounded at both ends. The cap keeps a many-core box from running
 * an unbounded number of file reads at once — each in-flight entry buffers its
 * whole file in memory before deflating, so peak memory scales with this number.
 * The floor keeps the work — which is largely I/O-bound — parallel even on a
 * single-vCPU container, where `availableParallelism()` returns 1.
 */
const MIN_DEFAULT_CONCURRENCY = 4;
const MAX_DEFAULT_CONCURRENCY = 16;

function defaultConcurrency(): number {
  return Math.max(MIN_DEFAULT_CONCURRENCY, Math.min(os.availableParallelism(), MAX_DEFAULT_CONCURRENCY));
}

export class ZipKit {
  readonly #policy: Partial<ArchivePolicy> | undefined;
  readonly #logger: Logger;
  readonly #concurrency: number;

  constructor(options: ZipKitOptions = {}) {
    this.#policy = options.policy ? validatePolicy(options.policy) : undefined;
    this.#logger = createLogger(options.logger);
    this.#concurrency =
      options.concurrency && options.concurrency > 0
        ? Math.floor(options.concurrency)
        : defaultConcurrency();
  }

  /** Scan and plan; writes nothing. */
  async plan(spec: ArchiveSpec): Promise<Plan> {
    try {
      const validated = validateSpec(spec);
      const policy = resolvePolicy(this.#policy, validated.policy);
      const matcher = buildMatcher(policy);
      const limit = pLimit(this.#concurrency);

      const scanResult = await scan(validated, policy, { matcher, limit, logger: this.#logger });
      const plan = planArchive(scanResult, policy);
      this.#reportPlan(plan);
      return plan;
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
  }

  /** Execute a plan produced by {@link ZipKit.plan}. */
  async write(plan: Plan): Promise<WriteResult> {
    const limit = pLimit(this.#concurrency);
    return this.#runWrite(plan, { limit, logger: this.#logger });
  }

  /** Plan and write in one call. */
  async create(spec: ArchiveSpec): Promise<WriteResult> {
    const plan = await this.plan(spec);
    const limit = pLimit(this.#concurrency);
    const deps = spec.signal
      ? { limit, logger: this.#logger, signal: spec.signal }
      : { limit, logger: this.#logger };
    return this.#runWrite(plan, deps);
  }

  /**
   * Read an archive: verify every entry's CRC-32, optionally reconcile against
   * the manifest (`checkMetadata`) and verify recorded SHA-256s, and — unless
   * `dryRun` is set — write the verified entries to `dest`. A dry run writes
   * nothing and is a pure integrity test that works on any ZIP.
   */
  async extract(spec: ExtractSpec): Promise<ExtractReport> {
    try {
      const validated = validateExtractSpec(spec);
      const deps = spec.signal
        ? { logger: this.#logger, signal: spec.signal }
        : { logger: this.#logger };
      return await extractArchive(validated, deps);
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
  }

  /** Execute the writer, reporting any failure to the log stream before it
   *  propagates. `plan()` reports its own failures, so `create()` does not
   *  double-report when its inner `plan()` throws. */
  async #runWrite(
    plan: Plan,
    deps: { limit: <T>(fn: () => Promise<T>) => Promise<T>; logger: Logger; signal?: AbortSignal },
  ): Promise<WriteResult> {
    try {
      return await writeArchive(plan, deps);
    } catch (err) {
      this.#reportError(err);
      throw err;
    }
  }

  /** Emit a terminal error event so a `--log` JSONL trail (and any SDK logger)
   *  records the failure instead of going silent mid-stream. Best-effort: the
   *  logger swallows its own faults, and the original error is always rethrown
   *  by the caller. */
  #reportError(err: unknown): void {
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
    this.#logger.emit(stage, "error", message, {
      data: cause !== undefined ? { code, cause } : { code },
    });
  }

  #reportPlan(plan: Plan): void {
    for (const entry of plan.entries) {
      if (entry.excluded) {
        this.#logger.emit("plan", "debug", "entry.excluded", {
          path: entry.archivePath,
          data: entry.excludeReason !== undefined ? { reason: entry.excludeReason } : undefined,
        });
      } else if (entry.archivePath !== entry.originalPath) {
        this.#logger.emit("plan", "debug", "entry.renamed", {
          path: entry.archivePath,
          data: { from: entry.originalPath },
        });
      }
    }
    for (const f of plan.findings) {
      const level = f.severity === "error" ? "error" : f.severity === "warning" ? "warn" : "info";
      this.#logger.emit("plan", level, "entry.flagged", {
        rule: f.rule,
        path: f.path,
        data: { severity: f.severity },
      });
    }
    this.#logger.emit("plan", "info", "plan.done", {
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
