/**
 * Main's side of the SDK host (./sdk-host): each call is one message to the
 * utility process and one reply back, with its Progress events and any
 * physical-settlement notice in between. The process starts on the first call.
 * When it ends, which an out-of-memory failure or a stuck volume can cause,
 * every call still waiting fails with `host.exited`, any write's physical
 * settlement is over, and the next call starts a fresh process.
 */

import type { LogEvent, ProgressCounts } from "../shared/api.js";
import type { HostReply, HostRequest, RemoteFailure, SdkOp, SdkOps } from "./sdk-host.js";

/** The utility process as the client sees it, so tests can supply their own. */
export interface HostProcess {
  postMessage(request: HostRequest): void;
  onMessage(listener: (reply: HostReply) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

/** A failure rebuilt in main with the fields it crossed with: an SDK error
 *  keeps its code, kind, effect, subject and details, so the SDK's
 *  `isZipKitError` recognizes it here as it would in the host. */
export class SdkHostError extends Error {
  readonly code: string | undefined;
  readonly kind: RemoteFailure["kind"];
  readonly effect: RemoteFailure["effect"];
  readonly subject: string | undefined;
  readonly details: unknown;
  readonly errno: RemoteFailure["errno"];
  readonly syscall: RemoteFailure["syscall"];
  readonly path: RemoteFailure["path"];
  constructor(failure: RemoteFailure) {
    super(failure.message, failure.cause !== undefined ? { cause: failure.cause } : undefined);
    if (failure.stack !== undefined) this.stack = failure.stack;
    this.errno = failure.errno;
    this.syscall = failure.syscall;
    this.path = failure.path;
    this.name = failure.name;
    this.code = failure.code;
    this.kind = failure.kind;
    this.effect = failure.effect;
    this.subject = failure.subject;
    this.details = failure.details;
  }
}

export interface CallOptions {
  signal?: AbortSignal;
  onEvent?: (event: LogEvent) => void;
  onProgress?: (counts: ProgressCounts) => void;
  onPhysicalSettlement?: (settlement: Promise<void>) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  options: CallOptions;
  release(): void;
}

export function createSdkClient(spawn: () => HostProcess) {
  let host: HostProcess | null = null;
  let nextId = 1;
  const calls = new Map<number, Pending>();
  // A write's publication can settle after its call has returned.
  const physical = new Map<number, () => void>();

  function finish(id: number): Pending | undefined {
    const call = calls.get(id);
    calls.delete(id);
    call?.release();
    return call;
  }

  function receive(reply: HostReply): void {
    switch (reply.type) {
      case "event":
        calls.get(reply.id)?.options.onEvent?.(reply.event);
        return;
      case "counts":
        calls.get(reply.id)?.options.onProgress?.(reply.counts);
        return;
      case "done":
        finish(reply.id)?.resolve(reply.value);
        return;
      case "failed":
        finish(reply.id)?.reject(new SdkHostError(reply.error));
        return;
      case "physical": {
        const settled = new Promise<void>((resolve) => physical.set(reply.id, resolve));
        calls.get(reply.id)?.options.onPhysicalSettlement?.(settled);
        return;
      }
      case "physical-settled":
        physical.get(reply.id)?.();
        physical.delete(reply.id);
        return;
    }
  }

  function exited(process: HostProcess, code: number): void {
    if (host !== process) return;
    host = null;
    // A process that has ended performs no more physical work.
    for (const settle of physical.values()) settle();
    physical.clear();
    const waiting = [...calls.keys()];
    for (const id of waiting) {
      finish(id)?.reject(new SdkHostError({
        name: "SdkHostExited",
        message: `ZipKit's archiving process ended (exit code ${code})`,
        code: "host.exited",
        kind: "unavailable",
        // Whatever it was doing may have landed before it ended.
        effect: "unknown",
      }));
    }
  }

  function running(): HostProcess {
    if (host) return host;
    const process = spawn();
    host = process;
    process.onMessage(receive);
    process.onExit((code) => exited(process, code));
    return process;
  }

  return {
    call<K extends SdkOp>(op: K, args: Parameters<SdkOps[K]>, options: CallOptions = {}): Promise<ReturnType<SdkOps[K]>> {
      const { signal } = options;
      if (signal?.aborted) return Promise.reject(signal.reason);
      const id = nextId++;
      const process = running();
      return new Promise((resolve, reject) => {
        const cancel = (): void => process.postMessage({ type: "cancel", id });
        signal?.addEventListener("abort", cancel, { once: true });
        calls.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          options,
          release: () => signal?.removeEventListener("abort", cancel),
        });
        process.postMessage({ type: "call", id, op, args });
      });
    },
    /** End the process now, as quit does once its own work is done. */
    stop(): void {
      const process = host;
      if (!process) return;
      exited(process, -1);
      process.kill();
    },
  };
}

export type SdkClient = ReturnType<typeof createSdkClient>;
