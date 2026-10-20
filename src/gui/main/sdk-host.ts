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
import { ZipKit, ZipKitError, type ErrorEffect, type ErrorKind, type PathResource, type PathState, type PlanData, type RemovalCheck, type VerifyRequest } from "zipkitsdk";
import type { LogEvent, ProgressCounts } from "zipkitsdk/types";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { InputEntry } from "../shared/queue.js";
import type { VerifyReport } from "../shared/api.js";
import { outputRequest } from "./output.js";

export interface SdkOps {
  resources(paths: string[]): PathResource[];
  pathState(path: string): PathState;
  plan(inputs: string[], options: GuiOptions): PlanData;
  write(plan: PlanData): number | null;
  verify(output: string, manifestName: string | null): boolean;
  deletePath(path: string): void;
  inspect(archive: string, manifestName: string | null): VerifyReport;
  checkRemoval(output: string, inputs: string[], removed: string[], options: GuiOptions): RemovalCheck;
  pathKinds(paths: string[]): InputEntry[];
}
export type SdkOp = keyof SdkOps;

export type HostRequest =
  | { type: "call"; id: number; op: SdkOp; args: unknown[] }
  | { type: "cancel"; id: number };

/** A failure as it crosses: an SDK error's own data (see the SDK's
 *  `ZipKitErrorData`), or the name, message and errno code of anything else,
 *  or the host's own `host.exited` when its process ends. */
export interface RemoteFailure {
  name: string;
  message: string;
  code?: string;
  kind?: ErrorKind;
  effect?: ErrorEffect;
  subject?: string;
  details?: unknown;
}

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
  // A system error's errno code crosses too, so main can tell a path that is
  // already gone (ENOENT) from a deletion that failed.
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" ? { name: err.name, message: err.message, code } : { name: err.name, message: err.message };
}

/** What a verification checks: the archive held to the manifest named, or,
 *  given none, to its own integrity. */
function verifyRequest(archive: string, manifestName: string | null): VerifyRequest {
  return manifestName === null ? { archive } : { archive, manifest: true, manifestName };
}

/** The SDK as the app runs it: debug events follow the app's own switch, and
 *  main records every event itself. */
export function appZipKit(): ZipKit {
  return new ZipKit({ debug: process.env.ZIPKIT_DEBUG === "1" });
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
    // What is at a path now: there with a comparable fingerprint, missing, or
    // out of reach on a drive that is not connected.
    pathState: (target: string) => (signal) => zip.pathState(target, { signal }),
    plan: (inputs: string[], options: GuiOptions) => async (signal, onEvent) => {
      const spec = buildSpec(inputs, options);
      Object.assign(spec, outputRequest(options.outputDir, options.fileName));
      // A plan is plain data, so it crosses to main and back as it is.
      return zip.plan(spec, { signal, onEvent });
    },
    write: (plan: PlanData) => async (signal, onEvent, id, onProgress) => {
      const written = await zip.write(plan, {
        signal,
        onEvent,
        onProgress,
        onPhysicalSettlement: (settlement) => {
          post({ type: "physical", id });
          const settled = (): void => post({ type: "physical-settled", id });
          settlement.then(settled, settled);
        },
      });
      // A refusal: an output appeared at the path since the plan.
      return written.mode === "write" ? written.bytes : null;
    },
    // Held to the manifest named, or, given none, to the archive's own integrity.
    verify: (output: string, manifestName: string | null) => async (signal, onEvent, _id, onProgress) =>
      (await zip.verify(verifyRequest(output, manifestName), { signal, onEvent, onProgress })).ok,
    // Deletes one original for good: a folder with everything in it, a file, or
    // a link itself, never what a link points to. Only after the job's checks.
    deletePath: (target: string) => async () => {
      await rm(target, { recursive: true });
    },
    // The report needs the verdict, the counts and the paths that disagree,
    // never every entry's result.
    inspect: (archive: string, manifestName: string | null) => async (signal, onEvent, _id, onProgress) => {
      const data = await zip.verify(verifyRequest(archive, manifestName), { signal, onEvent, onProgress });
      return { ok: data.ok, summary: data.summary, missing: data.missing, extra: data.extra } satisfies VerifyReport;
    },
    // A removal check is plain data, its errors included, so it crosses as it is.
    checkRemoval: (output: string, inputs: string[], removed: string[], options: GuiOptions) => (signal, onEvent, _id, onProgress) =>
      zip.checkRemoval({ spec: buildSpec(inputs, options), archive: output, removed }, { signal, onEvent, onProgress }),
    pathKinds: (paths: string[]) => (signal) => zip.pathKinds(paths, { signal }),
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
