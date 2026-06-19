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
 * This lives in the main process, not in the Node-free shared `spec.ts`: the
 * renderer typechecks `shared/` without `@types/node`, so the path/home logic
 * cannot live there.
 */

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
 * Compose the SDK's output path from the GUI's output **folder** and **file
 * name**, given the job's inputs. Both empty → "" so the SDK infers the archive
 * beside the input (cwd-independent, since inputs are absolute). When only one is
 * set, the other defaults from the first input: the folder to the input's parent,
 * the name to the input's basename + `.zip` (the SDK's beside-the-input form for a
 * single input). The folder must resolve to an absolute path.
 *
 * @throws Error when a typed folder is non-empty but not absolute (after `~`
 *   expansion) — never resolved against `process.cwd()`, whose value a
 *   double-clicked desktop app cannot rely on. The queue engine surfaces it as
 *   the job's message.
 */
export function resolveOutputPath(outputDir: string, fileName: string, inputs: string[]): string {
  const dir = outputDir.trim();
  const name = fileName.trim();
  if (dir === "" && name === "") return ""; // let the SDK infer beside the input

  const first = inputs[0];
  const baseDir = dir === "" ? (first ? path.dirname(first) : "") : expandHome(dir);
  const baseName = name === "" ? (first ? `${path.basename(first)}.zip` : "") : withZipExtension(name);
  if (baseDir === "" || baseName === "") return "";

  if (!path.isAbsolute(baseDir)) {
    throw new Error(
      `the output folder must be an absolute path (or empty to write beside the input); got a relative path: "${dir}"`,
    );
  }
  return path.join(baseDir, baseName);
}
