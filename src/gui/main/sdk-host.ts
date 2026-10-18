/**
 * The SDK's work, run in ZipKit's utility process (./sdk-host-entry) rather than
 * the main process: scanning, planning, writing, verifying and every look at
 * the files on the volumes the user chose. A folder too large for memory, or a
 * volume that stops answering, then costs that process alone; main keeps the
 * window, the saves and the quit, and reports the job's failure (volume-handling
 * conventions, Contain what cannot be avoided).
 *
 * The protocol is plain messages, so the host runs unchanged over Electron's
 * parent port and, in tests, over an in-process channel.
 */

import { rm } from "node:fs/promises";
import { exportPlan, importPlan, ZipKit, ZipKitError, type ErrorEffect, type ErrorKind, type PathResource, type PathState, type PlanTransfer, type RemovalCheck } from "zipkitsdk";
import type { LogEvent, ProgressCounts } from "zipkitsdk/types";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { InputEntry } from "../shared/queue.js";
import type { VerifyReport } from "../shared/api.js";
import { outputRequest } from "./output.js";
import { storageRoot } from "./storage.js";

export interface SdkOps {
  resources(paths: string[]): PathResource[];
  pathState(path: string): PathState;
  plan(inputs: string[], options: GuiOptions): PlanTransfer;
  write(transfer: PlanTransfer): number | null;
  verify(output: string, checkMetadata: boolean): boolean;
  deletePath(path: string): void;
  inspect(archive: string, checkMetadata: boolean): VerifyReport;
  checkRemoval(output: string, inputs: string[], removed: string[], options: GuiOptions): RemoteRemovalCheck;
  classify(paths: string[]): InputEntry[];
}
export type SdkOp = keyof SdkOps;

export type HostRequest =
  | { type: "call"; id: number; op: SdkOp; args: unknown[] }
  | { type: "cancel"; id: number };

/** A failure as it crosses: the fields main's error handling reads. */
/** A failure as it crosses: an SDK error's own data (see the SDK's
 *  `ZipKitErrorData`), or the name and message of anything else, or the
 *  host's own `host.exited` when its process ends. */
export interface RemoteFailure {
  name: string;
  message: string;
  code?: string;
  kind?: ErrorKind;
  effect?: ErrorEffect;
  subject?: string;
  details?: unknown;
}

/** A removal check as it crosses: a check that errored carries its failure. */
export type RemoteRemovalCheck = Omit<RemovalCheck, "refusal"> & {
  refusal: Exclude<RemovalCheck["refusal"], { reason: "error" }> | { reason: "error"; step: "location" | "verify" | "recheck"; error: RemoteFailure };
};

export type HostReply =
  | { type: "event"; id: number; event: LogEvent }
  | { type: "counts"; id: number; counts: ProgressCounts }
  | { type: "done"; id: number; value: unknown }
  | { type: "failed"; id: number; error: RemoteFailure }
  | { type: "physical"; id: number }
  | { type: "physical-settled"; id: number };

export function failure(err: unknown): RemoteFailure {
  if (err instanceof ZipKitError) return err.toJSON();
  if (!(err instanceof Error)) return { name: "Error", message: String(err) };
  return { name: err.name, message: err.message };
}

/** The SDK as the app runs it: ZipKit's own data folder is never archived,
 *  and debug events follow the app's own switch. Main records every event
 *  itself, so the SDK keeps no session log. */
export function appZipKit(): ZipKit {
  return new ZipKit({ skipPaths: [storageRoot()], debug: process.env.ZIPKIT_DEBUG === "1" });
}

export function createSdkHost(post: (reply: HostReply) => void, zip: ZipKit = appZipKit()) {
  const running = new Map<number, AbortController>();

  type Run = (
    signal: AbortSignal,
    onEvent: (event: LogEvent) => void,
    id: number,
    onProgress: (counts: ProgressCounts) => void,
  ) => Promise<unknown>;
  const ops: { [K in SdkOp]: (...args: never[]) => Run } = {
    resources: (paths: string[]) => (signal) => zip.pathResources(paths, { signal }),
    // What is at a path now: there with a comparable fingerprint, gone, or
    // out of reach on a drive that is not connected.
    pathState: (target: string) => (signal) => zip.pathState(target, { signal }),
    plan: (inputs: string[], options: GuiOptions) => async (signal, onEvent) => {
      const spec = buildSpec(inputs, options);
      Object.assign(spec, outputRequest(options.outputDir, options.fileName));
      const plan = await zip.plan(spec, { signal, onEvent });
      return exportPlan(plan);
    },
    write: (transfer: PlanTransfer) => async (signal, onEvent, id, onProgress) => {
      const written = await zip.write(importPlan(transfer), {
        signal,
        onEvent,
        onProgress,
        onPhysicalSettlement: (settlement) => {
          post({ type: "physical", id });
          const settled = (): void => post({ type: "physical-settled", id });
          settlement.then(settled, settled);
        },
      });
      return written.bytes;
    },
    verify: (output: string, checkMetadata: boolean) => async (signal, onEvent, _id, onProgress) =>
      (await zip.extract({ archive: output, dryRun: true, checkMetadata }, { signal, onEvent, onProgress })).reportOk,
    // Deletes one original for good: a folder with everything in it, a file, or
    // a link itself, never what a link points to. Only after the job's checks.
    deletePath: (target: string) => async () => {
      await rm(target, { recursive: true });
    },
    // The report needs the verdict, the counts and the paths that disagree,
    // never every entry's result.
    inspect: (archive: string, checkMetadata: boolean) => async (signal, onEvent, _id, onProgress) => {
      const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { signal, onEvent, onProgress });
      return { reportOk: data.reportOk, summary: data.summary, missing: data.missing, extra: data.extra } satisfies VerifyReport;
    },
    checkRemoval: (output: string, inputs: string[], removed: string[], options: GuiOptions) => async (signal, onEvent, _id, onProgress) => {
      const check = await zip.checkRemoval(buildSpec(inputs, options), output, { removed, signal, onEvent, onProgress });
      const refusal = check.refusal?.reason === "error" ? { ...check.refusal, error: failure(check.refusal.error) } : check.refusal;
      return { ...check, refusal } satisfies RemoteRemovalCheck;
    },
    classify: (paths: string[]) => (signal) => zip.classify(paths, { signal }),
  };

  return {
    handle(request: HostRequest): void {
      if (request.type === "cancel") {
        running.get(request.id)?.abort();
        return;
      }
      const { id, op, args } = request;
      const aborter = new AbortController();
      running.set(id, aborter);
      const run = (ops[op] as (...a: unknown[]) => Run)(...args);
      void run(aborter.signal, (event) => post({ type: "event", id, event }), id, (counts) => post({ type: "counts", id, counts })).then(
        (value) => post({ type: "done", id, value }),
        (err: unknown) => post({ type: "failed", id, error: failure(err) }),
      ).finally(() => running.delete(id));
    },
  };
}
