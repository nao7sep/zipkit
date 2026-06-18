/**
 * The single storage-root resolver — the one place that decides where zipkit
 * keeps its own files, per the storage-path convention. Every subpath (logs,
 * the GUI's queue) is derived from the root this module returns and from nowhere
 * else, so a single variable moves the whole tree and two derivations can never
 * disagree.
 *
 * The root is `~/.zipkit` by default, resolved from `os.homedir()` and from
 * nothing about how the app was launched — never the working directory, the
 * code's own location, or a packaged-versus-dev flag. The `ZIPKIT_HOME`
 * environment variable relocates the whole root: its value is expanded (a
 * leading `~` and `$VAR`/`%VAR%` references) and then made absolute *against the
 * home directory*, never against `process.cwd()`, so the override can never
 * reintroduce the cwd dependence the convention removes. A value that does not
 * resolve to a usable absolute path is a startup error, not a silent fallback.
 *
 * Resolution is lazy (a function call, not a module-level constant), so a
 * half-set environment is never frozen at import time. `ZIPKIT_LOG_DIR` remains
 * a narrower override layered on top of the resolved root's `logs/` (see
 * `defaultLogDir`).
 */

import { homedir } from "node:os";
import path from "node:path";

/**
 * The error thrown when `ZIPKIT_HOME` is set but unusable. Distinct so a startup
 * path can recognize a misconfiguration and stop with a clear message rather than
 * silently falling back to the default root.
 */
export class StorageRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageRootError";
  }
}

/**
 * Expand a leading `~` (the home directory) and any `$VAR` / `%VAR%` environment
 * references in a path string, before it is made absolute. The convention's
 * pre-absolutization expansion, applied to the `ZIPKIT_HOME` value. Unknown
 * variables expand to the empty string (the shell's behavior), which then fails
 * the usability check rather than producing a surprising literal path.
 */
function expand(value: string, env: NodeJS.ProcessEnv, home: string): string {
  let out = value;
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = home + out.slice(1);
  }
  out = out.replace(/\$(\w+)|\$\{(\w+)\}/g, (_m, a, b) => env[a ?? b] ?? "");
  out = out.replace(/%(\w+)%/g, (_m, name) => env[name] ?? "");
  return out;
}

/**
 * Resolve zipkit's storage root: `ZIPKIT_HOME` when set and non-empty (expanded
 * and absolutized against the home directory), else `~/.zipkit`. The root is not
 * created here — the first writer under it does the `mkdir -p` — so this stays a
 * pure path computation that the SDK and the GUI both call.
 *
 * @throws StorageRootError when `ZIPKIT_HOME` is set but expands to an empty or
 *   non-absolute path. The caller (a startup point) reports it and stops; it is
 *   never swallowed into the default.
 */
export function storageRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.ZIPKIT_HOME;
  if (override !== undefined && override.trim() !== "") {
    const expanded = expand(override.trim(), env, home);
    if (expanded === "") {
      throw new StorageRootError(
        `ZIPKIT_HOME is set but expands to an empty path: "${override}"`,
      );
    }
    // Relative values resolve against the home directory, never the working
    // directory — the convention's rule that keeps the override cwd-independent.
    const resolved = path.resolve(home, expanded);
    return resolved;
  }
  return path.join(home, ".zipkit");
}
