/**
 * End-to-end: the event stream reaches only each call's `onEvent`. Events carry
 * the `time`/`message` envelope; one `session.start` per instance leads them;
 * `debug` is gated; a failure ends in a `fault`; and the SDK writes no file of
 * its own and reads no environment variable for one.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit } from "../src/index.ts";
import type { LogEvent } from "../src/index.ts";

let root: string;
let proj: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-events-"));
  proj = path.join(root, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "alpha");
  await writeFile(path.join(proj, "b.txt"), "beta");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function collector(): { seen: LogEvent[]; onEvent: (e: LogEvent) => void } {
  const seen: LogEvent[] = [];
  return { seen, onEvent: (e) => { seen.push(e); } };
}

describe("the event stream", () => {
  it("opens with one startup event per instance, carrying the version and runtime config", async () => {
    const zip = new ZipKit({ concurrency: 8, chunkSize: 65536 });
    const { seen, onEvent } = collector();
    await zip.create({ inputs: [proj], output: path.join(root, "o1.zip") }, { onEvent });
    await zip.create({ inputs: [proj], output: path.join(root, "o2.zip") }, { onEvent });
    const startups = seen.filter((e) => e.event === "session.start");
    expect(startups).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "session.start", stage: "session", level: "info", version: "0.1.0", concurrency: 8, chunkSize: 65536 });
    expect(seen.filter((e) => e.event === "write.done")).toHaveLength(2);
  });

  it("stamps every event with the time/message envelope and gates debug off by default", async () => {
    const { seen, onEvent } = collector();
    await new ZipKit().create({ inputs: [proj], output: path.join(root, "o.zip") }, { onEvent });
    expect(seen.every((e) => typeof e.time === "string" && typeof e.message === "string")).toBe(true);
    const events = seen.map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["scan.done", "plan.done", "write.done"]));
    expect(events).not.toContain("entry.written");
    expect(events).not.toContain("scan.dir");
  });

  it("includes debug events when built with debug", async () => {
    const archive = path.join(root, "o.zip");
    const { seen, onEvent } = collector();
    const zip = new ZipKit({ debug: true });
    await zip.create({ inputs: [proj], output: archive }, { onEvent });
    await zip.verify(archive, { onEvent });
    expect(seen.map((e) => e.event)).toEqual(expect.arrayContaining(["entry.written", "entry.verified"]));
  });

  it("ends a failed run with a fault, and writes no file and reads no environment variable for a log", async () => {
    const dir = path.join(root, "env-logs");
    const previous = process.env.ZIPKIT_LOG_DIR;
    process.env.ZIPKIT_LOG_DIR = dir;
    try {
      const { seen, onEvent } = collector();
      const zip = new ZipKit();
      const plan = await zip.plan({ inputs: [proj], output: path.join(root, "o.zip") }, { onEvent });
      const written = await zip.write(plan, { onEvent });
      await zip.verify(written.output, { onEvent });
      await expect(zip.verify(path.join(root, "missing.zip"), { onEvent })).rejects.toThrow();
      expect(seen.map((e) => e.event)).toEqual(expect.arrayContaining(["plan.done", "write.done", "verify.done", "fault"]));
      await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).sort()).toEqual(["o.zip", "proj"]);
    } finally {
      if (previous === undefined) delete process.env.ZIPKIT_LOG_DIR;
      else process.env.ZIPKIT_LOG_DIR = previous;
    }
  });
});

describe("a plan as plain data", () => {
  it("is written after a structured clone or a JSON round trip, as in another process", async () => {
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], output: path.join(root, "cloned.zip") });
    expect((await zip.write(structuredClone(plan))).manifest.entries.length).toBe(2);
    const again = await zip.plan({ inputs: [proj], output: path.join(root, "json.zip") });
    expect((await zip.write(JSON.parse(JSON.stringify(again)))).manifest.entries.length).toBe(2);
    expect((await zip.verify(path.join(root, "json.zip"), { manifest: true })).ok).toBe(true);
  });
});
