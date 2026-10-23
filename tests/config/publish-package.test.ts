import { mkdtemp, mkdir, writeFile, readFile, rm, rename, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it, expect, onTestFinished } from "vitest";
// @ts-expect-error Both launcher families execute this ESM helper directly.
import { publishPackage } from "../../scripts/publish-package.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-rebuild-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"));
  await writeFile(path.join(root, "release", "previous"), "usable");
  return root;
}

describe("local package publication", () => {
  for (const executable of ["mac-arm64/ZipKit.app/Contents/MacOS/ZipKit", "win-unpacked/ZipKit.exe"]) {
    it(`keeps the previous package on failed candidate publication: ${executable}`, async () => {
      const root = await fixture();
      const candidate = path.join(root, ".rebuild-candidate");
      const destination = path.join(root, "release");
      await mkdir(path.dirname(path.join(candidate, executable)), { recursive: true });
      await writeFile(path.join(candidate, executable), "new");
      await expect(publishPackage(candidate, destination, executable, async (from: string, to: string) => {
        if (from === candidate) throw new Error("replacement denied");
        await rename(from, to);
      })).rejects.toThrow("replacement denied");
      expect(await readFile(path.join(destination, "previous"), "utf8")).toBe("usable");
      await publishPackage(candidate, destination, executable);
      expect(await readFile(path.join(destination, executable), "utf8")).toBe("new");
    });
    it(`rejects an incomplete candidate before moving previous package: ${executable}`, async () => {
      const root = await fixture();
      await expect(publishPackage(path.join(root, ".rebuild-missing"), path.join(root, "release"), executable)).rejects.toThrow();
      expect(await readFile(path.join(root, "release", "previous"), "utf8")).toBe("usable");
      await mkdir(path.join(root, ".rebuild-missing", executable), { recursive: true });
      await expect(publishPackage(path.join(root, ".rebuild-missing"), path.join(root, "release"), executable)).rejects.toThrow("not a file");
      expect(await readFile(path.join(root, "release", "previous"), "utf8")).toBe("usable");
    });
  }
});

async function runShell(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { cwd, env, stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end();
    child.stderr.resume();
    child.on("error", reject);
    child.on("exit", resolve);
  });
}

describe.skipIf(process.platform === "win32")("rebuild shell failure boundaries", () => {
  for (const stage of ["install", "typecheck", "build", "package"]) {
    it(`preserves the runnable package when ${stage} fails`, async () => {
      const root = await fixture();
      await mkdir(path.join(root, "scripts"));
      await cp(path.resolve("scripts/rebuild.command"), path.join(root, "scripts/rebuild.command"));
      await mkdir(path.join(root, "bin"));
      await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
      await mkdir(path.join(root, "node_modules/electron"));
      await writeFile(path.join(root, "node_modules/electron/path.txt"), "present");
      const stub = (name: string) => `#!/bin/bash\nif [[ "$FAIL_STAGE" == "${name}" ]]; then exit 27; fi\nexit 0\n`;
      await writeFile(path.join(root, "bin/npm"), stub("install"), { mode: 0o755 });
      await writeFile(path.join(root, "node_modules/.bin/tsc"), stub("typecheck"), { mode: 0o755 });
      await writeFile(path.join(root, "node_modules/.bin/electron-vite"), stub("build"), { mode: 0o755 });
      await writeFile(path.join(root, "node_modules/.bin/electron-builder"), stub("package"), { mode: 0o755 });
      const code = await runShell(path.join(root, "scripts/rebuild.command"), root, {
        ...process.env, FAIL_STAGE: stage, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
      });
      expect(code).not.toBe(0);
      expect(await readFile(path.join(root, "release/previous"), "utf8")).toBe("usable");
    });
  }
});
