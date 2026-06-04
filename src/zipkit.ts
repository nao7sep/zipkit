/**
 * The ZipKit SDK class (§6). `plan()` scans and runs the pure planning pass,
 * writing nothing; `write()` executes a plan; `create()` does both. The
 * `plan → inspect → write` flow is the reason ZipKit is an SDK and not only a
 * CLI: a caller computes the plan, reads `findings`, decides, then writes. The
 * plan carries the resolved output and the overwrite intent, so `write(plan)`
 * is self-contained. The per-call policy is merged over the instance policy.
 */

import pLimit from "p-limit";
import { buildMatcher } from "./filter/match.js";
import { createLogger } from "./log/logger.js";
import type { Logger } from "./log/logger.js";
import { planArchive } from "./plan/plan.js";
import { resolvePolicy } from "./policy.js";
import { scan } from "./scan/scan.js";
import { validatePolicy, validateSpec } from "./validate.js";
import { writeArchive } from "./write/write.js";
import type { ArchivePolicy, ArchiveSpec, Plan, WriteResult, ZipKitOptions } from "./types.js";

const DEFAULT_CONCURRENCY = 8;

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
        : DEFAULT_CONCURRENCY;
  }

  /** Scan and plan; writes nothing. */
  async plan(spec: ArchiveSpec): Promise<Plan> {
    const validated = validateSpec(spec);
    const policy = resolvePolicy(this.#policy, validated.policy);
    const matcher = buildMatcher(policy);
    const limit = pLimit(this.#concurrency);

    const scanResult = await scan(validated, policy, { matcher, limit, logger: this.#logger });
    const plan = planArchive(scanResult, policy);
    this.#reportPlan(plan);
    return plan;
  }

  /** Execute a plan produced by {@link ZipKit.plan}. */
  async write(plan: Plan): Promise<WriteResult> {
    const limit = pLimit(this.#concurrency);
    return writeArchive(plan, { limit, logger: this.#logger });
  }

  /** Plan and write in one call. */
  async create(spec: ArchiveSpec): Promise<WriteResult> {
    const plan = await this.plan(spec);
    const limit = pLimit(this.#concurrency);
    const deps = spec.signal
      ? { limit, logger: this.#logger, signal: spec.signal }
      : { limit, logger: this.#logger };
    return writeArchive(plan, deps);
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
