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

import { chmodSync, mkdirSync, statSync } from "node:fs";
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

/**
 * Creates the storage root if missing and, on POSIX, tightens it to owner-only
 * (0700) — created that way, and tightened at each launch when an existing
 * root is broader, per the storage-path convention: derived data and logs
 * must never be readable by accounts that cannot read their sources. Windows
 * uses its own permission model and is unaffected. `mkdirSync`'s own `mode`
 * is masked by umask and never changes an *existing* directory's mode, so
 * this always re-checks after creation rather than relying on the mkdir call
 * alone. Only the root itself is touched, never its contents.
 *
 * Called once at the defined startup point (see gui/main/index.ts) so every
 * launch goes through it; it does not replace each writer's own `mkdir -p`
 * for its subpath (logs/, backups.sqlite3, ...), which still runs on demand
 * regardless of whether this succeeded. A failure to create or tighten the
 * root is reported to stderr and never stops the app.
 */
export function secureStorageRoot(root: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (err) {
    process.stderr.write(
      `zipkit: could not create storage root "${root}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  if (process.platform === "win32") return;
  try {
    const mode = statSync(root).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      chmodSync(root, 0o700);
    }
  } catch (err) {
    process.stderr.write(
      `zipkit: could not tighten storage root "${root}" to owner-only (0700): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
