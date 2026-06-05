/**
 * The frozen output contract (docs/output-contract.md) at the CLI seam: the one
 * report envelope on stdout, JSONL progress/error framing on stderr, the
 * byte-identical `--json-out`/`--metadata-out` file levers, faults folded into
 * findings, and the D5 pre-verb minimal envelope. stdout/stderr are captured by
 * spying on the process write streams; the SDK paths are covered elsewhere.
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

function stdoutJson(): { schemaVersion: number; verb: string; ok: boolean; data: Record<string, unknown> } {
  return JSON.parse(out.join(""));
}

describe("create envelope", () => {
  it("emits exactly one pretty write-mode envelope on stdout and JSONL progress on stderr", async () => {
    const proj = await tree();
    const archive = path.join(dir, "o.zip");
    const code = await runCli(argv("create", proj, "-o", archive, "--json"));

    expect(code).toBe(0);
    // One report, parseable, with the frozen wrapper keys.
    const report = stdoutJson();
    expect(report.schemaVersion).toBe(1);
    expect(report).toMatchObject({ tool: "zipkit", verb: "create", ok: true });
    expect(report.data.mode).toBe("write");
    expect(report.data.written).toBe(true);
    expect(report.data.bytes).toBeTypeOf("number");

    // Progress converted to prefixed minified JSONL on stderr (not suppressed).
    const lines = err.join("").trim().split("\n");
    expect(lines.every((l) => l.startsWith("zipkit[progress]:"))).toBe(true);
    const scan = JSON.parse(lines[0]!.slice("zipkit[progress]:".length));
    expect(scan).toMatchObject({ schemaVersion: 1, event: "scan.done", entries: 2 });
    // Minified: no indentation in the JSONL record.
    expect(lines[0]).not.toContain("\n  ");
  });

  it("renders the dry-run plan envelope and exits 1 when not writable", async () => {
    const proj = await tree();
    const archive = path.join(dir, "exists.zip");
    await writeFile(archive, "preexisting");
    const code = await runCli(argv("create", proj, "-o", archive, "--dry-run", "--json"));

    expect(code).toBe(1);
    const report = stdoutJson();
    expect(report.verb).toBe("create");
    expect(report.data.mode).toBe("plan");
    expect(report.data.writable).toBe(false);
    expect(Array.isArray(report.data.entries)).toBe(true);
  });

  it("writes --json-out byte-identical to --json stdout, and --metadata-out byte-identical to the embedded manifest", async () => {
    const proj = await tree();
    const archive = path.join(dir, "ident.zip");
    const jsonOut = path.join(dir, "report.json");
    const metaOut = path.join(dir, "meta.json");
    const code = await runCli(
      argv("create", proj, "-o", archive, "--json", "--json-out", jsonOut, "--metadata-out", metaOut),
    );
    expect(code).toBe(0);

    expect((await readFile(jsonOut)).toString()).toBe(out.join(""));

    // The metadata-out file equals the embedded entry's bytes (no trailing
    // newline), so it can be diffed against `unzip -p`.
    const report = stdoutJson();
    const embedded = `${JSON.stringify((report.data as { metadata: unknown }).metadata, null, 2)}`;
    expect((await readFile(metaOut)).toString()).toBe(embedded);
  });
});

describe("create fault folding", () => {
  it("folds an operational write fault into findings, emits a live error event, and exits 1", async () => {
    const proj = await tree();
    const archive = path.join(dir, "missing-dir", "o.zip"); // parent does not exist
    const code = await runCli(argv("create", proj, "-o", archive, "--json"));

    expect(code).toBe(1);
    const report = stdoutJson();
    expect(report.ok).toBe(false);
    expect(report.data.mode).toBe("write");
    expect(report.data.written).toBe(false);
    expect(report.data.bytes).toBeNull();
    expect(report.data.metadata).toBeNull();
    const findings = report.data.findings as Array<{ severity: string }>;
    expect(findings.some((f) => f.severity === "error")).toBe(true);

    // The same fault rode out live on stderr as a [error] event.
    const errLines = err.join("").trim().split("\n");
    expect(errLines.some((l) => l.startsWith("zipkit[error]:"))).toBe(true);
  });
});

describe("D5 pre-verb minimal envelope", () => {
  it("still emits one minimal envelope on stdout under --json for a missing input", async () => {
    const archive = path.join(dir, "x.zip");
    const code = await runCli(argv("create", path.join(dir, "nope"), "-o", archive, "--json"));

    expect(code).toBe(2); // usage: the user named a path that isn't there
    const report = stdoutJson();
    expect(report.schemaVersion).toBe(1);
    expect(report.verb).toBe("create");
    expect(report.ok).toBe(false);
    const findings = report.data.findings as Array<{ rule: string; severity: string }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
  });

  it("emits a minimal envelope under --json when a required argument is missing", async () => {
    const code = await runCli(argv("create", "--json"));
    expect(code).toBe(2);
    const report = stdoutJson();
    expect(report.verb).toBe("create");
    expect((report.data.findings as unknown[]).length).toBe(1);
  });
});

describe("extract envelope", () => {
  it("emits the extract envelope and exits 0 on a clean dry-run validation", async () => {
    const proj = await tree();
    const archive = path.join(dir, "v.zip");
    await runCli(argv("create", proj, "-o", archive, "--quiet"));
    out.length = 0;
    err.length = 0;

    const code = await runCli(argv("extract", archive, "--dry-run", "--json"));
    expect(code).toBe(0);
    const report = stdoutJson();
    expect(report.verb).toBe("extract");
    expect(report.ok).toBe(true);
    expect(report.data.reportOk).toBe(true);
    expect(report.data.dryRun).toBe(true);
    expect(report.data.dest).toBeNull();
  });
});
