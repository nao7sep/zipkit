/**
 * The GUI's output-folder boundary. The SDK names and places the archive from
 * the folder and file name it is given (`outputDir`, `outputName`), inferring
 * either from the inputs when it is left out, and resolves a relative folder
 * against the working directory — right for a shell or script caller, wrong for
 * a desktop app, whose working directory is unpredictable (a double-clicked
 * macOS `.app` runs with cwd `/`). Per the storage-path convention the GUI hands
 * the SDK absolute folders only: a typed relative folder is rejected here, and a
 * leading `~` (and `~/`) is expanded to the home directory, the convention's
 * expansion for a user-supplied path.
 */

import { homedir } from "node:os";
import path from "node:path";
import type { ArchiveSpec } from "../../sdk/index.js";

/** Expand a leading `~`/`~/` to the home directory; leave any other string unchanged. */
function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? homedir() + p.slice(1) : p;
}

/**
 * The destination part of a spec from what the user set: a folder, a file
 * name, both, or neither (each left out is the SDK's to infer).
 *
 * @throws Error when a typed folder is not absolute after `~` expansion — never
 *   resolved against `process.cwd()`. The engine surfaces it.
 */
export function outputRequest(outputDir: string, fileName: string): Pick<ArchiveSpec, "outputDir" | "outputName"> {
  const request: Pick<ArchiveSpec, "outputDir" | "outputName"> = {};
  if (outputDir !== "") {
    const dir = expandHome(outputDir);
    if (!path.isAbsolute(dir)) {
      throw new Error(
        `the output directory must be an absolute path (or empty to write beside the input); got a relative path: "${outputDir}"`,
      );
    }
    request.outputDir = dir;
  }
  const name = fileName.trim();
  if (name !== "") request.outputName = name;
  return request;
}
