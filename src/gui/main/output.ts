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

/**
 * Normalize the GUI's typed output to what the SDK may safely consume: an empty
 * string (the SDK infers beside the input) or an absolute path. A non-empty
 * relative value is rejected — never resolved against `process.cwd()`.
 *
 * @throws Error when the trimmed, `~`-expanded output is non-empty but not
 *   absolute. The queue engine catches it and surfaces it as the job's message.
 */
export function resolveGuiOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed === "") return "";

  // Expand a leading `~`/`~/` to the home directory before the absoluteness check,
  // so a home-anchored path the user typed is accepted.
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? homedir() + trimmed.slice(1)
      : trimmed;

  if (!path.isAbsolute(expanded)) {
    throw new Error(
      `output must be an absolute path (or empty to write beside the input); got a relative path: "${trimmed}"`,
    );
  }
  return expanded;
}
