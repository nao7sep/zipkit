import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { AbortError } from "../../../src/sdk/errors.js";
import { awaitDrain } from "../../../src/sdk/internal/drain.js";

// The backpressure wait used to listen for "drain" and nothing else. A stream
// that errors instead of draining never emits it, so the await never settled:
// the job sat in `running` forever, everything queued behind it stalled, and
// Cancel did nothing because the wait did not consult the signal either.
//
// A stream only emits "drain" after write() has returned false, so each case
// below fills the buffer first — otherwise the test would pass without the
// production code doing anything.

/** A writable that accepts nothing, so the first write returns false. */
function backedUpStream(): Writable {
  return new Writable({
    highWaterMark: 1,
    write() {
      // Never calls the callback: the buffer stays full and "drain" is pending.
    },
  });
}

describe("awaitDrain", () => {
  it("resolves when the stream drains", async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    stream.resume();
    stream.write(Buffer.alloc(64));
    await expect(awaitDrain(stream)).resolves.toBeUndefined();
  });

  it("rejects when the stream errors instead of draining", async () => {
    const stream = backedUpStream();
    stream.write(Buffer.alloc(64));
    const pending = awaitDrain(stream);
    stream.emit("error", new Error("ENOSPC: no space left on device"));
    await expect(pending).rejects.toThrow(/ENOSPC/);
  });

  it("rejects when the signal aborts mid-wait, so Cancel works during a stall", async () => {
    const controller = new AbortController();
    const stream = backedUpStream();
    stream.write(Buffer.alloc(64));
    const pending = awaitDrain(stream, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = backedUpStream();
    stream.write(Buffer.alloc(64));
    await expect(awaitDrain(stream, controller.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it("leaves no listeners behind on any path", async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    stream.resume();
    stream.write(Buffer.alloc(64));
    await awaitDrain(stream);
    // A per-chunk helper that leaked a listener would climb toward Node's
    // max-listeners warning on any large entry.
    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });
});
