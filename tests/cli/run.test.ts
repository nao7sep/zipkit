/**
 * CLI contract tests: exit codes (0 success, 1 not writable, 2 usage),
 * `--dry-run` as the plan form, and exclusion — `--exclude` and
 * `--exclude-regex` both drop matching entries (the system is inclusive by
 * default; any matching rule excludes).
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/run.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function argv(...args: string[]): string[] {
  return ["node", "zipkit", ...args];
}

async function tree(): Promise<string> {
  const proj = path.join(dir, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, "keep.txt"), "keep");
  await writeFile(path.join(proj, "drop.txt"), "drop");
  return proj;
}

describe("exit codes", () => {
  it("returns 0 and writes the archive on success", async () => {
    const proj = await tree();
    const out = path.join(dir, "o.zip");
    const code = await runCli(argv("create", proj, "-o", out, "--quiet"));
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("returns 1 for a dry run that is not writable (output exists, no overwrite)", async () => {
    const proj = await tree();
    const out = path.join(dir, "exists.zip");
    await writeFile(out, "preexisting");
    const code = await runCli(argv("create", proj, "-o", out, "--dry-run", "--quiet"));
    expect(code).toBe(1);
  });

  it("returns 2 for a usage error", async () => {
    const code = await runCli(argv("create"));
    expect(code).toBe(2);
  });

  it("returns 2 for a non-coercible --chunk-size (rejected at the parse edge)", async () => {
    const proj = await tree();
    const out = path.join(dir, "c.zip");
    const code = await runCli(argv("create", proj, "-o", out, "--quiet", "--chunk-size", "abc"));
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false); // never ran
  });

  it("returns 2 for a non-positive --chunk-size (rejected by the SDK bound)", async () => {
    const proj = await tree();
    const out = path.join(dir, "z.zip");
    const code = await runCli(argv("create", proj, "-o", out, "--quiet", "--chunk-size", "0"));
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it("returns 2 for a non-coercible --jobs", async () => {
    const proj = await tree();
    const out = path.join(dir, "n.zip");
    const code = await runCli(argv("create", proj, "-o", out, "--quiet", "--jobs", "lots"));
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe("exclusion", () => {
  it("drops entries matched by --exclude (glob) and --exclude-regex, keeps the rest", async () => {
    const proj = await tree();
    await writeFile(path.join(proj, "notes.log"), "log");
    const out = path.join(dir, "i.zip");
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        chunks.push(String(chunk));
        return true;
      });

    const code = await runCli(
      argv(
        "create",
        proj,
        "-o",
        out,
        "--dry-run",
        "--quiet",
        "--exclude",
        "drop.txt",
        "--exclude-regex",
        "\\.log$",
      ),
    );
    spy.mockRestore();

    expect(code).toBe(0);
    const result = JSON.parse(chunks.join(""));
    expect(result.mode).toBe("plan");
    const byName = Object.fromEntries(
      result.entries.map((e: { archivePath: string; excluded: boolean }) => [
        e.archivePath,
        e.excluded,
      ]),
    );
    expect(byName["keep.txt"]).toBe(false); // kept by default (inclusive)
    expect(byName["drop.txt"]).toBe(true); // glob exclude
    expect(byName["notes.log"]).toBe(true); // regex exclude
    expect(existsSync(out)).toBe(false); // dry run writes nothing
  });
});
