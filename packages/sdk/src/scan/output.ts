/**
 * Output path resolution. An explicit `output` wins. Otherwise the archive's
 * folder and name are each given (`outputDir`, `outputName`) or inferred from
 * what is archived:
 *
 * - the name: a single folder keeps its name (`photos.zip`), a single file
 *   drops its extension (`notes.txt` → `notes.zip`) unless it is a `.zip`
 *   itself (`foo.zip` → `foo.zip.zip`), several things in one parent take the
 *   parent's name, and several in different parents, or at a root, which has
 *   no name, take the first one's (a root alone gives `archive.zip`); an
 *   inferred name one of the inputs already has beside it, as a
 *   case-insensitive file system sees it, gains another `.zip`, so the archive
 *   is never written onto an input; a given name gains `.zip` when it lacks it;
 * - the folder: beside a single input, or in the one parent several share;
 *   inputs in different parents need an `outputDir`, or an `outputName`, which
 *   then puts the archive beside the first input. Guessing a folder is wrong,
 *   so otherwise it is an error with no fallback.
 *
 * Pure path arithmetic; the existence check is the scan edge's job.
 */

import path from "node:path";
import { PolicyError } from "../errors.js";
import { foldedName } from "../internal/name-equivalence.js";
import type { ResolvedInput } from "../plan/arcname.js";

/** Where the caller asked the archive to go. */
export interface OutputRequest {
  output?: string | undefined;
  outputDir?: string | undefined;
  outputName?: string | undefined;
}

function withZipExtension(name: string): string {
  return /\.zip$/i.test(name) ? name : `${name}.zip`;
}

/** The name a root (`/`, `D:\`) gives, having none of its own. */
const ROOT_NAME = "archive";

/** The archive name an input gives when it is archived alone. */
function nameFor(input: string, isDir: boolean): string {
  const base = path.basename(input) || ROOT_NAME;
  if (isDir) return `${base}.zip`;
  if (/\.zip$/i.test(base)) return `${base}.zip`;
  const ext = path.extname(base);
  return `${ext ? base.slice(0, -ext.length) : base}.zip`;
}

export function resolveOutputPath(
  request: OutputRequest,
  inputs: ResolvedInput[],
  isDir: boolean[],
  cwd: string,
): string {
  if (request.output !== undefined) return path.resolve(cwd, request.output);
  const first = inputs[0];
  if (!first) throw new PolicyError("output.ambiguous", "no inputs to infer an output path from");
  const parents = new Set(inputs.map((input) => path.dirname(input.path)));
  const shared = parents.size === 1 ? path.dirname(first.path) : null;

  const name = request.outputName !== undefined
    ? withZipExtension(request.outputName.trim())
    : inputs.length === 1 || shared === null || path.basename(shared) === ""
      ? nameFor(first.path, isDir[0] === true)
      : `${path.basename(shared)}.zip`;

  let dir: string;
  if (request.outputDir !== undefined) dir = path.resolve(cwd, request.outputDir);
  else if (shared !== null) dir = shared;
  else if (request.outputName !== undefined) dir = path.dirname(first.path);
  else {
    throw new PolicyError(
      "output.ambiguous",
      "cannot infer the output path: inputs live in different parents; pass an output, an outputDir or an outputName",
    );
  }
  return path.join(dir, request.outputName !== undefined ? name : besideInputs(name, dir, inputs));
}

/** An inferred name, with `.zip` added until no input in `dir` has it. Any
 *  file system may fold case and Unicode forms, so the names compare folded:
 *  a needless `.zip.zip` costs nothing, writing onto an input fails the plan. */
function besideInputs(name: string, dir: string, inputs: ResolvedInput[]): string {
  const taken = new Set(inputs.filter((input) => path.dirname(input.path) === dir)
    .map((input) => foldedName(path.basename(input.path), "win32")));
  let free = name;
  while (taken.has(foldedName(free, "win32"))) free = `${free}.zip`;
  return free;
}
