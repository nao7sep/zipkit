/**
 * The real Records window in Electron, over a throwaway data folder seeded
 * with 10,000 records while three more arrive each second: the first page,
 * paging through every record, live records at the top, a list that holds
 * still while scrolled down, and a window that keeps answering. The checks
 * themselves are the demo's `--check` mode (`tests/dev/records-demo.ts`);
 * this builds it, runs it and reads its verdict. It needs the built app and
 * a display, so it runs in the full gate.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));

async function run(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const [code] = (await once(child, "exit")) as [number | null];
  expect(code, output).toBe(0);
  return output;
}

it("pages, updates live and holds still over 10,000 records in the real window", async () => {
  await run(process.execPath, ["node_modules/electron-vite/bin/electron-vite.js", "build", "--config", "tests/dev/records-demo.config.ts"]);
  const root = mkdtempSync(path.join(tmpdir(), "zipkit-records-live-"));
  try {
    const output = await run(electron as unknown as string,
      ["out/records-demo/main/records-demo.js", "--check", "--seed=10000", `--root=${root}`]);
    const line = output.split("\n").find((text) => text.startsWith("RECORDS-CHECK "));
    expect(line, output).toBeDefined();
    process.stdout.write(`${line}\n`);
    const result = JSON.parse(line!.slice("RECORDS-CHECK ".length)) as { pass: boolean };
    expect(result, line).toMatchObject({ pass: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
