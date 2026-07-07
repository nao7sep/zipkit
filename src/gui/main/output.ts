/**
 * The GUI's output-path boundary. The shared core (the SDK) interprets a
 * relative output against the *working directory* — correct for a shell or script
 * caller, but wrong for a desktop app, whose working directory is unpredictable
 * (a double-clicked macOS `.app` runs with cwd `/`). Per the storage-path
 * convention, the GUI must hand the core absolute paths only: a user-typed
 * relative string in the Output field is rejected here, before it reaches the
 * SDK, rather than silently resolving under `/`.
 *
 * An empty output is left empty so the SDK infers the archive's location *beside
 * the input* — and because every input the GUI supplies is an absolute path from
 * the native dialog, that inference is itself cwd-independent. A leading `~`
 * (and `~/`) is expanded to the home directory, the convention's expansion for a
 * user-supplied path, so `~/Desktop/out.zip` is a valid absolute output.
 *
 * The default NAME (when the user set an output directory but no file name)
 * mirrors the SDK's beside-the-input inference: a directory keeps its name, a file
 * drops its extension (`strategy.md` → `strategy.zip`). Knowing which it is is the
 * one impure edge — `resolveOutputPath` stats the input; the rest is the pure
 * `composeOutputPath`. This lives in the main process, not the Node-free shared
 * `spec.ts`: the renderer typechecks `shared/` without `@types/node`.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Expand a leading `~`/`~/` to the home directory (the convention's expansion
 *  for a user-supplied path); leave any other string unchanged. */
function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? homedir() + p.slice(1) : p;
}

/** Ensure exactly one trailing `.zip` (case-insensitive); append it when absent. */
function withZipExtension(name: string): string {
  return /\.zip$/i.test(name) ? name : `${name}.zip`;
}

/**
 * The default archive name for an auto-named single input, mirroring the SDK's
 * beside-the-input inference (`sdk/scan/output.ts`): a DIRECTORY keeps its
 * (possibly dotted) name; a FILE drops its extension (`strategy.md` → `strategy`).
 * An input already named `*.zip` keeps its full name (→ `foo.zip.zip`) so the
 * archive never collides with the very input it archives — re-zipping a `.zip` is
 * separately surfaced as a report advisory, not silently overwritten.
 */
function defaultName(base: string, isDir: boolean): string {
  if (isDir) return withZipExtension(base);
  if (/\.zip$/i.test(base)) return `${base}.zip`; // foo.zip → foo.zip.zip (no self-collision)
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}.zip`;
}

/**
 * Pure composition given whether the first input is a directory. Both empty → ""
 * so the SDK infers beside the input. Otherwise each side defaults from the first
 * input: the directory to its parent, the name via {@link defaultName}. The
 * directory must resolve to an absolute path.
 *
 * @throws Error when a typed directory is non-empty but not absolute (after `~`
 *   expansion) — never resolved against `process.cwd()`. The engine surfaces it.
 */
export function composeOutputPath(
  outputDir: string,
  fileName: string,
  inputs: string[],
  firstIsDir: boolean,
): string {
  const dir = outputDir.trim();
  const name = fileName.trim();
  if (dir === "" && name === "") return ""; // let the SDK infer beside the input

  const first = inputs[0];
  const baseDir = dir === "" ? (first ? path.dirname(first) : "") : expandHome(dir);
  const baseName =
    name === "" ? (first ? defaultName(path.basename(first), firstIsDir) : "") : withZipExtension(name);
  if (baseDir === "" || baseName === "") return "";

  if (!path.isAbsolute(baseDir)) {
    throw new Error(
      `the output directory must be an absolute path (or empty to write beside the input); got a relative path: "${dir}"`,
    );
  }
  return path.join(baseDir, baseName);
}

/** Whether a path is a directory on disk; false (treat as a file) if it cannot be
 *  stat'd, so a vanished input still composes a name rather than throwing here. */
async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the output path. Stats the first input ONLY when a default name must be
 * inferred (a directory keeps its name, a file drops its extension) — the single
 * impure edge over the pure {@link composeOutputPath}.
 */
export async function resolveOutputPath(
  outputDir: string,
  fileName: string,
  inputs: string[],
): Promise<string> {
  const needsDefaultName = fileName.trim() === "" && outputDir.trim() !== "" && inputs.length > 0;
  const firstIsDir = needsDefaultName ? await isDirectory(inputs[0]!) : false;
  return composeOutputPath(outputDir, fileName, inputs, firstIsDir);
}
