/**
 * CLI contract tests (§7): exit codes (0 success, 1 not writable, 2 usage),
 * `--dry-run` as the plan form, and the normative interleave behaviour where
 * all include/exclude flags share one ordered list so first-match-wins works
 * across mixed flags.
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
    const code = await runCli(argv("create", proj, "-o", out, "--dry-run", "--json", "--quiet"));
    expect(code).toBe(1);
  });

  it("returns 2 for a usage error", async () => {
    const code = await runCli(argv("create"));
    expect(code).toBe(2);
  });
});

describe("filter interleave", () => {
  it("applies first-match-wins across mixed include/exclude flags", async () => {
    const proj = await tree();
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
        "--json",
        "--quiet",
        "--include",
        "keep.txt",
        "--exclude",
        "*",
      ),
    );
    spy.mockRestore();

    expect(code).toBe(0);
    const plan = JSON.parse(chunks.join(""));
    const byName = Object.fromEntries(
      plan.entries.map((e: { archivePath: string; excluded: boolean }) => [e.archivePath, e.excluded]),
    );
    expect(byName["keep.txt"]).toBe(false);
    expect(byName["drop.txt"]).toBe(true);
    expect(existsSync(out)).toBe(false); // dry run writes nothing
  });
});
