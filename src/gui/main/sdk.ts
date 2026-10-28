/**
 * The SDK as ZipKit's main process runs it: scanning, planning, writing,
 * verifying and every look at the files on the volumes the user chose. Its
 * file calls are Node's asynchronous file APIs and zlib streams, which run on
 * libuv's threadpool, so main stays responsive while a job reads or writes.
 * Memory stays bounded by streaming (volume-handling conventions), so no
 * separate process contains a large folder.
 */

import { rm } from "node:fs/promises";
import { ZipKit, type PathState, type PlanData, type RemovalCheck, type VerifyRequest } from "zipkitsdk";
import type { LogEvent, ProgressCounts } from "zipkitsdk/types";
import { APP_NAME, APP_VERSION } from "../shared/identity.js";
import { buildSpec, type GuiOptions } from "../shared/spec.js";
import type { InputEntry } from "../shared/queue.js";
import type { VerifyReport } from "../shared/api.js";
import { outputRequest } from "./output.js";

/** What one SDK call answers to and reports through. */
export interface SdkCall {
  signal?: AbortSignal;
  onEvent?: (event: LogEvent) => void;
  onProgress?: (counts: ProgressCounts) => void;
}

/** What a verification checks: the archive held to the manifest named, or,
 *  given none, to its own integrity. */
function verifyRequest(archive: string, manifestName: string | null): VerifyRequest {
  return manifestName === null ? { archive } : { archive, manifest: true, manifestName };
}

/** The SDK as the app runs it: its manifests name ZipKit and its version
 *  beside the SDK, debug events follow the app's own switch, and main records
 *  every event itself. */
export function appZipKit(): ZipKit {
  return new ZipKit({ app: { name: APP_NAME, version: APP_VERSION }, debug: process.env.ZIPKIT_DEBUG === "1" });
}

/** The verbs the queue engine uses, in the app's terms. */
export function createSdk(zip: ZipKit = appZipKit()) {
  return {
    // What is at a path now: there with a comparable fingerprint, missing, or
    // out of reach on a drive that is not connected.
    pathState: (target: string, call: SdkCall = {}): Promise<PathState> => zip.pathState(target, call),
    plan: (inputs: string[], options: GuiOptions, call: SdkCall = {}): Promise<PlanData> => {
      const spec = buildSpec(inputs, options);
      Object.assign(spec, outputRequest(options.outputDir, options.fileName));
      return zip.plan(spec, call);
    },
    // The byte count, or null on a refusal: an output appeared at the path
    // since the plan.
    write: async (plan: PlanData, call: SdkCall = {}): Promise<number | null> => {
      const written = await zip.write(plan, call);
      return written.mode === "write" ? written.bytes : null;
    },
    // Held to the manifest named, or, given none, to the archive's own integrity.
    verify: async (output: string, manifestName: string | null, call: SdkCall = {}): Promise<boolean> =>
      (await zip.verify(verifyRequest(output, manifestName), call)).ok,
    // The report needs the verdict, the counts and the paths that disagree,
    // never every entry's result.
    inspect: async (archive: string, manifestName: string | null, call: SdkCall = {}): Promise<VerifyReport> => {
      const data = await zip.verify(verifyRequest(archive, manifestName), call);
      return { ok: data.ok, summary: data.summary, missing: data.missing, extra: data.extra };
    },
    checkRemoval: (output: string, inputs: string[], removed: string[], options: GuiOptions, call: SdkCall = {}): Promise<RemovalCheck> =>
      zip.checkRemoval({ spec: buildSpec(inputs, options), archive: output, removed }, call),
    pathKinds: (paths: string[], call: SdkCall = {}): Promise<InputEntry[]> => zip.pathKinds(paths, call),
    // Deletes one original for good: a folder with everything in it, a file, or
    // a link itself, never what a link points to. Only after the job's checks.
    deletePath: (target: string): Promise<void> => rm(target, { recursive: true }),
  };
}

export type Sdk = ReturnType<typeof createSdk>;

/** The app's one SDK instance. */
export const sdk = createSdk();
