/**
 * The scan edge over a real temporary tree. Covers the I/O-heavy behaviors the
 * pure planner cannot exercise: forward-slash archive paths, junk-directory
 * pruning during the walk, symlink handling across ignore/follow, the cycle
 * guard and input-tree escape rule, broken-link drop, a symlink given directly
 * as a top-level input, and the output-artifact self-exclusion.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMatcher } from "../../src/filter/match.js";
import { createLogger } from "../../src/log/logger.js";
import { resolvePolicy } from "../../src/policy.js";
import { scan } from "../../src/scan/scan.js";
import type { ArchivePolicy, ArchiveSpec } from "../../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-scan-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(policy: ArchivePolicy) {
  return {
    matcher: buildMatcher(policy),
    limit: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    logger: createLogger(),
  };
}

async function runScan(spec: ArchiveSpec, partial: Partial<ArchivePolicy> = {}) {
  const policy = resolvePolicy(undefined, partial);
  return scan(spec, policy, deps(policy));
}

function names(result: { entries: { archivePath: string }[] }): string[] {
  return result.entries.map((e) => e.archivePath).sort();
}

describe("scan over a real tree", () => {
  it("surfaces files and directories with forward-slash archive paths", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "sub"), { recursive: true });
    await writeFile(path.join(proj, "a.txt"), "a");
    await writeFile(path.join(proj, "sub", "b.txt"), "b");

    const result = await runScan({ inputs: [proj] });

    expect(names(result)).toEqual(["a.txt", "sub", "sub/b.txt"]);
    expect(result.entries.find((e) => e.archivePath === "sub")?.type).toBe("dir");
    expect(result.entries.find((e) => e.archivePath === "sub/b.txt")?.type).toBe("file");
  });

  it("prunes excluded junk directories during the walk", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "__MACOSX"), { recursive: true });
    await writeFile(path.join(proj, "__MACOSX", "x.txt"), "junk");
    await writeFile(path.join(proj, "keep.txt"), "keep");

    const result = await runScan({ inputs: [proj] });

    expect(names(result)).toEqual(["keep.txt"]);
    expect(result.prunedDirs.map((d) => d.archivePath)).toContain("__MACOSX");
  });

  it("surfaces a symlink as a symlink entry under the default ignore policy", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "real.txt"), "real");
    await symlink("real.txt", path.join(proj, "link"));

    const result = await runScan({ inputs: [proj] });

    const link = result.entries.find((e) => e.archivePath === "link");
    expect(link?.type).toBe("symlink");
    expect(link?.linkTarget).toBe("real.txt");
  });

  it("follows an internal symlinked directory under follow", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "data"), { recursive: true });
    await writeFile(path.join(proj, "data", "f.txt"), "f");
    await symlink("data", path.join(proj, "mirror"));

    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });

    expect(names(result)).toContain("data/f.txt");
    expect(names(result)).toContain("mirror/f.txt");
    const mirrored = result.entries.find((e) => e.archivePath === "mirror/f.txt");
    expect(mirrored?.type).toBe("file");
  });

  it("guards against symlink cycles under follow", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(path.join(proj, "child"), { recursive: true });
    await writeFile(path.join(proj, "child", "f.txt"), "f");
    // A symlink pointing back at its own parent directory.
    await symlink("../child", path.join(proj, "child", "self"));

    // The guard's contract is that this terminates rather than recursing
    // forever; a hang would fail the test by timeout.
    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });

    expect(names(result)).toContain("child/f.txt");
    expect(names(result)).toContain("child/self/f.txt");
    // Followed once, then the cycle guard stops descent — not twice.
    expect(names(result)).not.toContain("child/self/self/f.txt");
  });

  it("skips a symlink that escapes the input tree unless followExternal is set", async () => {
    const proj = path.join(dir, "proj");
    const outside = path.join(dir, "outside");
    await mkdir(proj, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink("../outside", path.join(proj, "escape"));

    const blocked = await runScan({ inputs: [proj] }, { symlinks: "follow" });
    expect(names(blocked)).not.toContain("escape/secret.txt");

    const allowed = await runScan(
      { inputs: [proj] },
      { symlinks: "follow", followExternal: true },
    );
    expect(names(allowed)).toContain("escape/secret.txt");
  });

  it("drops a broken symlink under follow", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "real.txt"), "real");
    await symlink("does-not-exist", path.join(proj, "dangling"));

    const result = await runScan({ inputs: [proj] }, { symlinks: "follow" });

    expect(names(result)).toEqual(["real.txt"]);
  });

  it("follows a symlink given directly as a top-level input", async () => {
    const realdir = path.join(dir, "realdir");
    await mkdir(realdir, { recursive: true });
    await writeFile(path.join(realdir, "f.txt"), "f");
    const linkdir = path.join(dir, "linkdir");
    await symlink("realdir", linkdir);

    // Default policy is "ignore", but an explicit symlink input is always
    // followed because it was named by the caller.
    const result = await runScan({ inputs: [linkdir] });

    expect(names(result)).toContain("f.txt");
  });

  it("never archives the output file or its atomic-write temp artifacts", async () => {
    const proj = path.join(dir, "proj");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "a.txt"), "a");
    const output = path.join(proj, "out.zip");
    await writeFile(output, "existing archive");
    await writeFile(path.join(proj, "out.zip.stale123"), "stale temp");

    const result = await runScan({ inputs: [proj], output });

    expect(names(result)).toEqual(["a.txt"]);
    expect(result.outputExists).toBe(true);
  });
});
