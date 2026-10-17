// Builds the package's SDK and CLI into dist/: JavaScript with type
// declarations, from a clean folder so nothing removed from src lingers, and
// the CLI marked executable. `npm pack` runs it first (prepack).
import { chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
await rm(new URL("dist/", root), { recursive: true, force: true });
const tsc = spawnSync("tsc", ["-p", "tsconfig.sdk.json"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
await chmod(new URL("dist/cli/zipkit.js", root), 0o755);
