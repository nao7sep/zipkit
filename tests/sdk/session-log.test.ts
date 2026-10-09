/**
 * End-to-end: one ZipKit instance keeps one session log under its `logDir`,
 * named with a seconds stamp and a random id; events carry the `time`/`message` envelope;
 * `debug` is gated; `result.log` identifies the file; the `onProgress` stream
 * carries exactly what the file holds; and `sessionLog: false` writes no file.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PolicyError, ZipKit } from "../../src/sdk/index.js";
import type { LogEvent } from "../../src/sdk/index.js";

let root: string;
let logDir: string;
let proj: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-sdklog-"));
  logDir = path.join(root, "logs");
  proj = path.join(root, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "alpha");
  await writeFile(path.join(proj, "b.txt"), "beta");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.ZIPKIT_DEBUG;
});

/** Locate the lone session log under `logDir` and parse its JSONL lines. */
async function sessionLines(): Promise<Record<string, unknown>[]> {
  const files = (await readdir(logDir)).filter((f) => f.endsWith(".log"));
  expect(files).toHaveLength(1);
  return (await readFile(path.join(logDir, files[0]!), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("SDK session log", () => {
  it("plan() then write() on one instance share a single session log named by result.log", async () => {
    const zip = new ZipKit({ logDir });
    const plan = await zip.plan({ inputs: [proj], output: path.join(root, "o.zip") });
    const result = await zip.write(plan);

    const files = (await readdir(logDir)).filter((f) => f.endsWith(".log"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}-utc-[0-9a-z]{12}\.log$/);
    expect(result.log).toBe(path.join(logDir, files[0]!));
    expect(plan.log).toBe(result.log); // one instance, one session
  });

  it("opens the session with one startup line carrying the version and runtime config", async () => {
    const zip = new ZipKit({ logDir, concurrency: 8, chunkSize: 65536 });
    await zip.create({ inputs: [proj], output: path.join(root, "o1.zip") });
    await zip.create({ inputs: [proj], output: path.join(root, "o2.zip"), overwrite: true });

    const lines = await sessionLines();
    const startups = lines.filter((l) => l.event === "session.start");
    expect(startups).toHaveLength(1); // once per session, not once per verb
    expect(lines[0]?.event).toBe("session.start"); // and it leads the log
    expect(startups[0]).toMatchObject({
      stage: "session",
      level: "info",
      version: "0.1.0",
      concurrency: 8,
      chunkSize: 65536,
    });
  });

  it("logs info events with the time/message envelope and gates debug off by default", async () => {
    const zip = new ZipKit({ logDir });
    await zip.create({ inputs: [proj], output: path.join(root, "o.zip") });

    const lines = await sessionLines();
    expect(lines.every((l) => typeof l.time === "string" && typeof l.message === "string")).toBe(true);
    const events = lines.map((l) => l.event);
    expect(events).toContain("scan.done");
    expect(events).toContain("write.done");
    expect(events).not.toContain("entry.written"); // debug, gated off
    expect(events).not.toContain("scan.dir");
  });

  it("includes debug events when ZIPKIT_DEBUG=1", async () => {
    process.env.ZIPKIT_DEBUG = "1";
    const zip = new ZipKit({ logDir });
    await zip.create({ inputs: [proj], output: path.join(root, "o.zip") });

    expect((await sessionLines()).map((l) => l.event)).toContain("entry.written");
  });

  it("appends successive verbs on one instance to the one session file", async () => {
    const zip = new ZipKit({ logDir });
    await zip.create({ inputs: [proj], output: path.join(root, "o1.zip") });
    await zip.create({ inputs: [proj], output: path.join(root, "o2.zip"), overwrite: true });

    const writeDone = (await sessionLines()).filter((l) => l.event === "write.done");
    expect(writeDone).toHaveLength(2); // both runs in the one session file
  });

  /** Build the archive with a throwaway instance whose log goes elsewhere, so the
   *  session log under `logDir` holds only the extract run we assert on. */
  async function buildArchive(): Promise<string> {
    const archive = path.join(root, "e.zip");
    await new ZipKit({ logDir: path.join(root, "build-logs") }).create({ inputs: [proj], output: archive });
    return archive;
  }

  it("records extract's info events in the session log (gating per-entry debug off)", async () => {
    const archive = await buildArchive();
    await new ZipKit({ logDir }).extract({ archive, dryRun: true });

    const events = (await sessionLines()).map((l) => l.event);
    expect(events).toContain("extract.start");
    expect(events).toContain("extract.done");
    expect(events).not.toContain("entry.verified"); // debug, gated off by default
  });

  it("records per-entry entry.verified in the extract log under ZIPKIT_DEBUG=1", async () => {
    const archive = await buildArchive();
    process.env.ZIPKIT_DEBUG = "1";
    await new ZipKit({ logDir }).extract({ archive, dryRun: true });

    expect((await sessionLines()).map((l) => l.event)).toContain("entry.verified");
  });

  it("hands onProgress every line the session log holds, session.start included, for each verb", async () => {
    const archive = await buildArchive();
    const zip = new ZipKit({ logDir });
    const seen: LogEvent[] = [];
    const onProgress = (e: LogEvent): void => {
      seen.push(e);
    };
    const plan = await zip.plan({ inputs: [proj], output: path.join(root, "o.zip") }, { onProgress });
    await zip.write(plan, { onProgress });
    await zip.extract({ archive, dryRun: true, checkMetadata: true }, { onProgress });
    await expect(zip.extract({ archive: path.join(root, "missing.zip"), dryRun: true }, { onProgress })).rejects.toThrow();

    const lines = await sessionLines();
    expect(seen.map((e) => e.event)).toContain("fault");
    expect(seen[0]?.event).toBe("session.start");
    expect(JSON.parse(JSON.stringify(seen))).toEqual(lines);
  });
});

describe("SDK without a session log", () => {
  it("writes no log file, returns a null log, and still streams session.start first", async () => {
    const dir = path.join(root, "default-logs");
    const previous = process.env.ZIPKIT_LOG_DIR;
    process.env.ZIPKIT_LOG_DIR = dir;
    try {
      const zip = new ZipKit({ sessionLog: false });
      const seen: LogEvent[] = [];
      const onProgress = (e: LogEvent): void => {
        seen.push(e);
      };
      const plan = await zip.plan({ inputs: [proj], output: path.join(root, "o.zip") }, { onProgress });
      const written = await zip.write(plan, { onProgress });
      const extracted = await zip.extract({ archive: written.output, dryRun: true }, { onProgress });

      expect([plan.log, written.log, extracted.log]).toEqual([null, null, null]);
      await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(seen.filter((e) => e.event === "session.start")).toHaveLength(1);
      expect(seen[0]?.event).toBe("session.start");
      expect(seen.map((e) => e.event)).toEqual(expect.arrayContaining(["plan.done", "write.done", "extract.done"]));
    } finally {
      if (previous === undefined) delete process.env.ZIPKIT_LOG_DIR;
      else process.env.ZIPKIT_LOG_DIR = previous;
    }
  });

  it("keeps the session log on by default and with sessionLog: true", async () => {
    const result = await new ZipKit({ logDir, sessionLog: true }).create({ inputs: [proj], output: path.join(root, "o.zip") });
    expect(result.log).toMatch(/\d{8}-\d{6}-utc-[0-9a-z]{12}\.log$/);
    expect((await sessionLines()).length).toBeGreaterThan(0);
  });

  it("rejects a non-boolean sessionLog and a logDir beside sessionLog: false", () => {
    expect(() => new ZipKit({ sessionLog: "no" as never })).toThrow(PolicyError);
    expect(() => new ZipKit({ sessionLog: false, logDir })).toThrow(PolicyError);
  });
});
