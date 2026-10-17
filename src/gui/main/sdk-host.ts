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
import { exportPlan, importPlan, ZipKit, type PathState, type PlanTransfer } from "../../sdk/index.js";
import type { LogEvent, SourceComparison } from "../../sdk/types.js";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { InputEntry } from "../shared/queue.js";
import type { VerifyReport } from "../shared/api.js";
import { fileResources, type FileResource } from "./archive-effects.js";
import { outputRequest } from "./output.js";
import { outputInsideInputs } from "./safety.js";
import { storageRoot } from "./storage.js";

export interface SdkOps {
  resources(paths: string[]): FileResource[];
  pathState(path: string): PathState;
  plan(inputs: string[], options: GuiOptions): PlanTransfer;
  write(transfer: PlanTransfer): number | null;
  verify(output: string, checkMetadata: boolean): boolean;
  deletePath(path: string): void;
  inspect(archive: string, checkMetadata: boolean): VerifyReport;
  recheck(output: string, inputs: string[], options: GuiOptions): SourceComparison;
  classify(paths: string[]): InputEntry[];
  outputInsideInputs(output: string, inputs: string[]): boolean;
}
export type SdkOp = keyof SdkOps;

export type HostRequest =
  | { type: "call"; id: number; op: SdkOp; args: unknown[] }
  | { type: "cancel"; id: number };

/** A failure as it crosses: the fields main's error handling reads. */
export interface RemoteFailure {
  name: string;
  message: string;
  errorType?: string;
  code?: string;
  path?: string;
}

export type HostReply =
  | { type: "event"; id: number; event: LogEvent }
  | { type: "done"; id: number; value: unknown }
  | { type: "failed"; id: number; error: RemoteFailure }
  | { type: "physical"; id: number }
  | { type: "physical-settled"; id: number };

function failure(err: unknown): RemoteFailure {
  if (!(err instanceof Error)) return { name: "Error", message: String(err) };
  const fields = err as Error & { errorType?: unknown; code?: unknown; path?: unknown };
  const out: RemoteFailure = { name: err.name, message: err.message };
  if (typeof fields.errorType === "string") out.errorType = fields.errorType;
  if (typeof fields.code === "string") out.code = fields.code;
  if (typeof fields.path === "string") out.path = fields.path;
  return out;
}

/** The SDK as the app runs it: ZipKit's own data folder is never archived,
 *  and debug events follow the app's own switch. Main records every event
 *  itself, so the SDK keeps no session log. */
export function appZipKit(): ZipKit {
  return new ZipKit({ skipPaths: [storageRoot()], debug: process.env.ZIPKIT_DEBUG === "1" });
}

export function createSdkHost(post: (reply: HostReply) => void, zip: ZipKit = appZipKit()) {
  const running = new Map<number, AbortController>();

  type Run = (signal: AbortSignal, onProgress: (event: LogEvent) => void, id: number) => Promise<unknown>;
  const ops: { [K in SdkOp]: (...args: never[]) => Run } = {
    resources: (paths: string[]) => (signal) => fileResources(paths, zip.volume(signal)),
    // What is at a path now: there with a comparable fingerprint, gone, or
    // out of reach on a drive that is not connected.
    pathState: (target: string) => (signal) => zip.pathState(target, { signal }),
    plan: (inputs: string[], options: GuiOptions) => async (signal, onProgress) => {
      const spec = buildSpec(inputs, options);
      Object.assign(spec, outputRequest(options.outputDir, options.fileName));
      const plan = await zip.plan(spec, { signal, onProgress });
      return exportPlan(plan);
    },
    write: (transfer: PlanTransfer) => async (signal, onProgress, id) => {
      const written = await zip.write(importPlan(transfer), {
        signal,
        onProgress,
        onPhysicalSettlement: (settlement) => {
          post({ type: "physical", id });
          const settled = (): void => post({ type: "physical-settled", id });
          settlement.then(settled, settled);
        },
      });
      return written.bytes;
    },
    verify: (output: string, checkMetadata: boolean) => async (signal, onProgress) =>
      (await zip.extract({ archive: output, dryRun: true, checkMetadata }, { signal, onProgress })).reportOk,
    // Deletes one original for good: a folder with everything in it, a file, or
    // a link itself, never what a link points to. Only after the job's checks.
    deletePath: (target: string) => async () => {
      await rm(target, { recursive: true });
    },
    // The report needs the verdict, the counts and the paths that disagree,
    // never every entry's result.
    inspect: (archive: string, checkMetadata: boolean) => async (signal, onProgress) => {
      const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { signal, onProgress });
      return { reportOk: data.reportOk, summary: data.summary, missing: data.missing, extra: data.extra } satisfies VerifyReport;
    },
    recheck: (output: string, inputs: string[], options: GuiOptions) => (signal, onProgress) => {
      // The archive is the output: naming it keeps the fresh scan from counting
      // the archive itself when it sits beside the inputs.
      const spec = buildSpec(inputs, options);
      spec.output = output;
      return zip.compareSources(spec, output, { signal, onProgress });
    },
    classify: (paths: string[]) => (signal) => zip.classify(paths, { signal }),
    outputInsideInputs: (output: string, inputs: string[]) => (signal) =>
      outputInsideInputs(output, inputs, zip.volume(signal)),
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
      void run(aborter.signal, (event) => post({ type: "event", id, event }), id).then(
        (value) => post({ type: "done", id, value }),
        (err: unknown) => post({ type: "failed", id, error: failure(err) }),
      ).finally(() => running.delete(id));
    },
  };
}
