/**
 * The output behavior at the CLI seam: exactly one typed result document on
 * stdout (JSON, no envelope), bare JSONL progress on stderr, and faults rendered
 * on stderr only — stdout stays empty on failure. A negative verdict (a
 * non-writable plan, a not-ok extract) is a clean run: its result rides on
 * stdout and the exit code is 1. stdout/stderr are captured by spying on the
 * process write streams; the SDK paths are covered elsewhere.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/run.js";

let dir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-report-"));
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function argv(...args: string[]): string[] {
  return ["node", "zipkit", ...args];
}

async function tree(): Promise<string> {
  const proj = path.join(dir, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "alpha");
  await writeFile(path.join(proj, "b.txt"), "beta");
  return proj;
}

/** The single result document on stdout, parsed. There is no envelope: stdout is
 *  the verb's typed result object (CreateData / ExtractData) directly. */
function stdoutJson(): Record<string, unknown> {
  return JSON.parse(out.join(""));
}

/** Every stderr line that parses as JSON (the bare-JSONL progress + a final
 *  error object on failure), in order. */
function stderrObjects(): Record<string, unknown>[] {
  return err
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe("create output", () => {
  it("emits one result document on stdout and bare JSONL progress on stderr", async () => {
    const proj = await tree();
    const archive = path.join(dir, "o.zip");
    const code = await runCli(argv("create", proj, "-o", archive));

    expect(code).toBe(0);
    // The raw write-mode result, no wrapping envelope.
    const result = stdoutJson();
    expect(result.mode).toBe("write");
    expect(result.written).toBe(true);
    expect(result.bytes).toBeTypeOf("number");
    expect(result.schemaVersion).toBeUndefined(); // no envelope
    expect(result.verb).toBeUndefined();

    // Progress is bare JSONL — every line a whole LogEvent, no prefix.
    const lines = err.join("").trim().split("\n");
    expect(lines.every((l) => !l.startsWith("zipkit["))).toBe(true);
    const events = stderrObjects();
    expect(events.every((e) => typeof e.stage === "string" && typeof e.event === "string")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: "scan.done", entries: 2 }));
  });

  it("emits the dry-run plan result and exits 1 when not writable", async () => {
    const proj = await tree();
    const archive = path.join(dir, "exists.zip");
    await writeFile(archive, "preexisting");
    const code = await runCli(argv("create", proj, "-o", archive, "--dry-run"));

    expect(code).toBe(1);
    const result = stdoutJson();
    expect(result.mode).toBe("plan");
    expect(result.writable).toBe(false);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it("renders an operational write fault on stderr only, leaving stdout empty (exit 4)", async () => {
    const proj = await tree();
    const archive = path.join(dir, "missing-dir", "o.zip"); // parent does not exist
    const code = await runCli(argv("create", proj, "-o", archive));

    expect(code).toBe(4); // write runtime fault → domain exit code 4
    expect(out.join("")).toBe(""); // nothing on stdout
    // The fault is rendered on stderr as a structured error object (write domain).
    const error = stderrObjects().find((o) => o.error)?.error as
      | { type: string; code: string }
      | undefined;
    expect(error?.type).toBe("write");
  });
});

describe("usage faults", () => {
  it("renders a missing input as a plain stderr line and exits 2, stdout empty", async () => {
    const archive = path.join(dir, "x.zip");
    const code = await runCli(argv("create", path.join(dir, "nope"), "-o", archive));

    expect(code).toBe(2); // usage: the user named a path that isn't there
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/^error: /m); // plain one-line message
  });

  it("exits 2 for a missing required argument", async () => {
    const code = await runCli(argv("create"));
    expect(code).toBe(2);
    expect(out.join("")).toBe(""); // commander wrote its usage to stderr, not stdout
  });
});

describe("extract output", () => {
  it("emits the extract result and exits 0 on a clean dry-run validation", async () => {
    const proj = await tree();
    const archive = path.join(dir, "v.zip");
    await runCli(argv("create", proj, "-o", archive, "--quiet"));
    out.length = 0;
    err.length = 0;

    const code = await runCli(argv("extract", archive, "--dry-run"));
    expect(code).toBe(0);
    const result = stdoutJson();
    expect(result.reportOk).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.dest).toBeNull();
  });

  it("renders a read runtime fault on stderr only and exits 5", async () => {
    // An openable file that is not a ZIP throws read.not-zip mid-run — a runtime
    // fault (distinct from read.open-failed, which is a usage error).
    const archive = path.join(dir, "bogus.zip");
    await writeFile(archive, "this is plainly not a zip archive");

    const code = await runCli(argv("extract", archive, "--dry-run"));
    expect(code).toBe(5); // read runtime fault → domain exit code 5
    expect(out.join("")).toBe("");
    const error = stderrObjects().find((o) => o.error)?.error as { type: string } | undefined;
    expect(error?.type).toBe("read");
  });
});

describe("--log JSONL sink (both verbs)", () => {
  it("writes the event stream as JSONL on extract, independent of --quiet", async () => {
    const proj = await tree();
    const archive = path.join(dir, "logged.zip");
    await runCli(argv("create", proj, "-o", archive, "--quiet"));

    const logPath = path.join(dir, "extract.jsonl");
    const code = await runCli(argv("extract", archive, "--dry-run", "--quiet", "--log", logPath));
    expect(code).toBe(0);

    const lines = (await readFile(logPath)).toString().trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l) as { stage: string; event: string });
    // Every line is a well-formed LogEvent, and the run's terminal event is present.
    expect(events.every((e) => typeof e.stage === "string" && typeof e.event === "string")).toBe(true);
    expect(events.some((e) => e.event === "extract.done")).toBe(true);
    // Extraction emits per-entry progress (one entry.verified per archive entry).
    expect(events.some((e) => e.event === "entry.verified")).toBe(true);
  });

  it("writes scan.dir and per-entry entry.written as JSONL on create", async () => {
    const proj = await tree();
    const archive = path.join(dir, "logged-create.zip");
    const logPath = path.join(dir, "create.jsonl");
    const code = await runCli(argv("create", proj, "-o", archive, "--quiet", "--log", logPath));
    expect(code).toBe(0);

    const events = (await readFile(logPath))
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; stage: string });
    expect(events.some((e) => e.event === "scan.dir")).toBe(true);
    expect(events.some((e) => e.event === "entry.written")).toBe(true);
    expect(events.some((e) => e.event === "write.done")).toBe(true);
  });

  it("records a fault event whose stage comes from the fault's domain, not its code string", async () => {
    const archive = path.join(dir, "bogus.zip");
    await writeFile(archive, "plainly not a zip archive");
    const logPath = path.join(dir, "fault.jsonl");

    const code = await runCli(argv("extract", archive, "--dry-run", "--quiet", "--log", logPath));
    expect(code).toBe(5); // a read runtime fault

    const events = (await readFile(logPath))
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; stage: string; code?: string });
    const fault = events.find((e) => e.event === "fault");
    expect(fault?.stage).toBe("extract"); // read errorType → extract stage, not a "read." prefix
    expect(fault?.code).toBe("read.not-zip");
  });
});
