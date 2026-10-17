// Builds the SDK and its CLI into dist/: JavaScript with type declarations,
// from a clean folder so nothing removed from src lingers, and the CLI marked
// executable. `npm pack` runs it first (prepack).
import { spawnSync } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(path.join(root, "dist"), { recursive: true, force: true });
// TypeScript exports no path to its command; it sits beside its package.json.
const typescript = path.dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
const tsc = spawnSync(process.execPath, [path.join(typescript, "bin", "tsc"), "-p", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
await chmod(path.join(root, "dist", "cli", "zipkit.js"), 0o755);
