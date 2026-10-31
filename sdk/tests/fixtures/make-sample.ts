/**
 * Writes the saved sample for the current manifest format: the archive the
 * SDK makes from the sample tree, and what its manifest must keep saying.
 * Run it once when a format version is introduced (`node
 * tests/fixtures/make-sample.ts` in the package); a saved sample is never
 * regenerated for a version already released, because it is the evidence of
 * what that version wrote.
 */

import { mkdtemp, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipKit } from "../../src/index.ts";
import { MANIFEST_FORMAT_VERSION } from "../../src/write/manifest.ts";
import { makeSampleTree, manifestEssentials, SAMPLE_POLICY } from "./sample-tree.ts";
import { readManifest } from "../helpers/manifest.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), "zipkit-sample-"));
try {
  const tree = await makeSampleTree(work);
  const archive = path.join(work, "sample.zip");
  await new ZipKit().create({ inputs: [tree], output: archive, policy: SAMPLE_POLICY });
  const name = `format-${MANIFEST_FORMAT_VERSION}`;
  await copyFile(archive, path.join(here, `${name}.zip`));
  await writeFile(path.join(here, `${name}.expected.json`), `${JSON.stringify(manifestEssentials(readManifest(archive)), null, 2)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
