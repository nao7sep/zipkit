/**
 * End-to-end: the event stream reaches only each call's `onEvent`. Events carry
 * the `time`/`message` envelope; one `session.start` per instance reaches the
 * first call that listens; `debug` is gated; a failure ends in one `fault`
 * carrying the error as thrown; and the SDK writes no file of its own.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipKit, ZipKitError } from "../src/index.ts";
import type { LogEvent } from "../src/index.ts";
import { resolvePolicy } from "../src/policy.ts";
import { VERSION } from "../src/version.ts";
import { written } from "./helpers/written.ts";

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
    const zip = new ZipKit({ chunkSize: 65536 });
    const { seen, onEvent } = collector();
    await zip.create({ inputs: [proj], output: path.join(root, "o1.zip") }, { onEvent });
    await zip.create({ inputs: [proj], output: path.join(root, "o2.zip") }, { onEvent });
    const startups = seen.filter((e) => e.event === "session.start");
    expect(startups).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: "session.start", stage: "session", level: "info", version: VERSION, chunkSize: 65536, debug: false,
    });
    expect(seen.filter((e) => e.event === "write.done")).toHaveLength(2);
  });

  it("gives the startup event to the first call that listens, with the instance policy resolved", async () => {
    const policy = { emptyDirs: "prune" as const };
    const zip = new ZipKit({ policy, debug: true });
    await zip.plan({ inputs: [proj], output: path.join(root, "quiet.zip") });
    await zip.pathState(proj);
    const { seen, onEvent } = collector();
    await zip.plan({ inputs: [proj], output: path.join(root, "heard.zip") }, { onEvent });
    expect(seen[0]).toMatchObject({ event: "session.start", debug: true, policy: resolvePolicy(policy, undefined) });
  });

  it("records a failure once, as the error thrown, and a cancellation at info", async () => {
    const zip = new ZipKit();
    const { seen, onEvent } = collector();
    const missing = path.join(root, "missing.zip");
    const thrown = await zip.verify({ archive: missing }, { onEvent }).catch((e: unknown) => e);
    const faults = seen.filter((e) => e.event === "fault");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ level: "error", error: (thrown as ZipKitError).toJSON() });
    expect(faults[0]).toMatchObject({ error: { code: "path.missing", kind: "unavailable", subject: missing } });

    const cancelled = collector();
    const controller = new AbortController();
    controller.abort();
    await expect(zip.plan({ inputs: [proj] }, { onEvent: cancelled.onEvent, signal: controller.signal })).rejects.toMatchObject({ code: "operation.cancelled" });
    expect(cancelled.seen.filter((e) => e.event === "fault")).toEqual([
      expect.objectContaining({ level: "info", error: expect.objectContaining({ code: "operation.cancelled", kind: "cancelled" }) }),
    ]);
  });

  it("records no fault for a removal check that refuses because a step could not finish", async () => {
    const zip = new ZipKit();
    const { seen, onEvent } = collector();
    const check = await zip.checkRemoval({ spec: { inputs: [proj] }, archive: path.join(root, "absent.zip") }, { onEvent });
    expect(check.refusal).toMatchObject({ reason: "error", step: "verify", error: { code: "path.missing" } });
    const junk = path.join(root, "junk.zip");
    await writeFile(junk, "not a zip");
    const failed = await zip.checkRemoval({ spec: { inputs: [proj] }, archive: junk }, { onEvent });
    expect(failed.refusal).toMatchObject({ reason: "error", step: "verify", error: { code: "archive.not-zip", subject: junk } });
    expect(seen.filter((e) => e.event === "fault")).toEqual([]);
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
    await zip.verify({ archive }, { onEvent });
    expect(seen.map((e) => e.event)).toEqual(expect.arrayContaining(["entry.written", "entry.verified"]));
  });

  it("ends a failed run with a fault, and writes no file of its own", async () => {
    const { seen, onEvent } = collector();
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], output: path.join(root, "o.zip") }, { onEvent });
    const output = written(await zip.write(plan, { onEvent })).output;
    await zip.verify({ archive: output }, { onEvent });
    await expect(zip.verify({ archive: path.join(root, "missing.zip") }, { onEvent })).rejects.toThrow();
    expect(seen.map((e) => e.event)).toEqual(expect.arrayContaining(["plan.done", "write.done", "verify.done", "fault"]));
    expect((await readdir(root)).sort()).toEqual(["o.zip", "proj"]);
  });
});

describe("a plan as plain data", () => {
  it("is written after a structured clone or a JSON round trip, as in another process", async () => {
    const zip = new ZipKit();
    const plan = await zip.plan({ inputs: [proj], output: path.join(root, "cloned.zip") });
    expect(written(await zip.write(structuredClone(plan))).manifest.entries.length).toBe(2);
    const again = await zip.plan({ inputs: [proj], output: path.join(root, "json.zip") });
    expect(written(await zip.write(JSON.parse(JSON.stringify(again)))).manifest.entries.length).toBe(2);
    expect((await zip.verify({ archive: path.join(root, "json.zip"), manifest: true })).ok).toBe(true);
  });
});
