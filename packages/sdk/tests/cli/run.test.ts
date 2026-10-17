/**
 * The `zipkit` command, run in-process: each command's output and exit code,
 * the archive options reaching the spec, and the errors a script branches on.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, formatBytes, run } from "../../src/cli/run.js";
import { VERSION, ZipKit } from "../../src/index.js";

let root: string;
let proj: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zipkit-cli-"));
  proj = path.join(root, "proj");
  await mkdir(path.join(proj, "sub"), { recursive: true });
  await writeFile(path.join(proj, "a.txt"), "alpha");
  await writeFile(path.join(proj, "sub", "b:c.txt"), "bravo");
  await writeFile(path.join(proj, ".DS_Store"), "junk");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function zipkit(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const code = await run(argv, { stdout: { write: (t: string) => (out += t) }, stderr: { write: (t: string) => (err += t) } });
  return { code, out, err };
}

describe("zipkit", () => {
  it("plans without writing, then creates, verifies and lists the archive", async () => {
    const output = path.join(root, "out.zip");
    const planned = await zipkit("plan", proj, "-o", output);
    expect(planned.code).toBe(EXIT.ok);
    expect(planned.out).toContain(`Archive: ${output}`);
    expect(planned.out).toContain("Items: 3 included, 1 excluded, 1 renamed (10 B)");
    expect(planned.out).toMatch(/notes {3}.*macos\.junk ×1/);
    expect(planned.out).toContain("Writable: yes");

    const created = await zipkit("create", proj, "-o", output);
    expect(created.code).toBe(EXIT.ok);
    expect(created.out).toContain(`Wrote ${output}`);
    expect((await zipkit("verify", output)).out).toBe("OK: 4 entries verified against the manifest\n");
    const listed = (await zipkit("list", output)).out.split("\n");
    expect(listed.some((line) => line.endsWith("  sub/b_c.txt"))).toBe(true);
    expect(listed.some((line) => line.endsWith("  sub/"))).toBe(true);
  });

  it("refuses to create over an existing archive unless told to, and says why", async () => {
    const output = path.join(root, "out.zip");
    await zipkit("create", proj, "-o", output);
    const again = await zipkit("create", proj, "-o", output);
    expect(again.code).toBe(EXIT.refused);
    expect(again.out).toMatch(/error {3}output\.exists/);
    expect(again.out).toContain("Writable: no");
    expect((await zipkit("create", proj, "-o", output, "--overwrite")).code).toBe(EXIT.ok);
  });

  it("passes the archive options on to the plan", async () => {
    const out = await zipkit("plan", proj, "--output-dir", root, "--name", "named", "--no-junk", "--exclude", "*.txt", "--names", "error", "--json");
    const plan = JSON.parse(out.out);
    expect(plan.output).toBe(path.join(root, "named.zip"));
    const excluded = plan.entries.filter((e: { excluded: boolean }) => e.excluded).map((e: { archivePath: string }) => e.archivePath).sort();
    expect(excluded).toEqual(["a.txt", "sub/b:c.txt"]);
    // Kept, now that junk is not left out.
    expect(plan.entries.some((e: { archivePath: string; excluded: boolean }) => e.archivePath === ".DS_Store" && !e.excluded)).toBe(true);
    const named = await zipkit("plan", path.join(proj, "sub"), "--names", "error", "-o", path.join(root, "x.zip"));
    expect(named.code).toBe(EXIT.refused);
    expect(named.out).toMatch(/error {3}name\.invalid-char/);
  });

  it("writes an archive without a manifest, which only a CRC check can verify", async () => {
    const output = path.join(root, "bare.zip");
    expect((await zipkit("create", proj, "-o", output, "--no-manifest", "-q")).out).toBe("");
    const strict = await zipkit("verify", output);
    expect(strict.code).toBe(EXIT.read);
    expect(strict.err).toContain("read.manifest-missing");
    expect((await zipkit("verify", output, "--crc-only")).out).toBe("OK: 3 entries verified\n");
  });

  it("reports a failed verification with what failed, and an archive that is not there", async () => {
    const output = path.join(root, "out.zip");
    // A stored entry, so a changed byte fails its CRC-32 rather than its inflate.
    await writeFile(path.join(proj, "photo.jpg"), "JPEG-BYTES-0123456789");
    await new ZipKit().create({ inputs: [proj], output });
    const bytes = await readFile(output);
    const at = bytes.indexOf("JPEG-BYTES");
    bytes[at] = "X".charCodeAt(0);
    await writeFile(output, bytes);
    const failed = await zipkit("verify", output);
    expect(failed.code).toBe(EXIT.refused);
    expect(failed.out).toMatch(/extract\.crc-fail {2}photo\.jpg/);
    expect(failed.out).toMatch(/Failed: \d+ problems? in /);
    const missing = await zipkit("verify", path.join(root, "missing.zip"));
    expect(missing.code).toBe(EXIT.read);
    expect(missing.err).toContain("(read.open-failed)");
  });

  it("answers usage mistakes with the help and exit code 2, and prints its version", async () => {
    for (const argv of [[], ["frobnicate"], ["plan"], ["verify"], ["plan", proj, "--names", "maybe"], ["plan", proj, "--bogus"]]) {
      const result = await zipkit(...argv);
      expect(result.code, argv.join(" ")).toBe(EXIT.usage);
      expect(result.err).toContain("Usage: zipkit");
    }
    expect((await zipkit("--help")).code).toBe(EXIT.ok);
    expect((await zipkit("--version")).out).toBe(`${VERSION}\n`);
  });

  it("maps an input that is not there to the scan exit code, naming the error's code", async () => {
    const result = await zipkit("plan", path.join(root, "nowhere"));
    expect(result.code).toBe(EXIT.scan);
    expect(result.err).toMatch(/\(scan\.[a-z-]+\)\n$/);
  });

  it("writes sizes in decimal units", () => {
    expect([999, 1000, 208_540_997, 12_000_000_000].map(formatBytes)).toEqual(["999 B", "1.0 kB", "209 MB", "12 GB"]);
  });
});
