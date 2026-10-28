/**
 * The removal recheck through the queue engine and the real SDK: an original
 * edited after the archive was made, to the same size and with its time put
 * back, stops the move to the Trash. The check verifies the archive, then
 * reads every original again, and the job names the changed file where it is
 * on disk.
 */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ZipKit, type ProgressCounts } from "zipkitsdk";
import { createQueueEngine } from "../../../src/gui/main/queue-engine.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { TRASH } from "../../helpers/intents.js";
import { realPathState } from "../../helpers/archiveState.js";

it("keeps the originals when one was edited to the same size with its time put back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-recheck-"));
  const input = path.join(root, "proj"), output = path.join(root, "proj.zip");
  await mkdir(input);
  await writeFile(path.join(input, "a.txt"), "alpha");
  await writeFile(path.join(input, "b.txt"), "bravo");
  const edited = path.join(input, "a.txt");
  // A whole-second time, so putting it back is exact on every file system.
  const when = new Date("2020-01-02T03:04:05Z");
  await utimes(edited, when, when);
  const zip = new ZipKit();
  const stages: ProgressCounts["stage"][] = [];
  const trash = vi.fn(async (paths: string[]) => ({ moved: paths, failed: [] }));
  const engine = createQueueEngine({
    admission: new CommandAdmission(),
    plan: (inputs, options, signal) => zip.plan({ ...buildSpec(inputs, options), output }, { signal }),
    write: async (plan, signal, onEvent) => {
      const result = await zip.write(plan, { signal, onEvent });
      // After the archive is made: same size, first byte changed, time put back.
      await writeFile(edited, "Alpha");
      await utimes(edited, when, when);
      return result.mode === "write" ? result.bytes : null;
    },
    verify: async (archive, signal) => (await zip.verify({ archive, manifest: true }, { signal })).ok,
    checkRemoval: (archive, inputs, removed, options, signal, onEvent) =>
      zip.checkRemoval({ spec: buildSpec(inputs, options), archive, removed }, { signal, onEvent, onProgress: (counts) => { if (stages.at(-1) !== counts.stage) stages.push(counts.stage); } }),
    pathKinds: async (paths) => paths.map((p) => ({ path: p, kind: "directory" as const })),
    deleteOriginals: async (paths: string[]) => ({ moved: paths, failed: [] }),
    pathState: realPathState,
    inspect: async () => { throw new Error("not used"); },
    trash, emit: () => {}, progress: () => () => {}, newId: () => "job", log: nullLog,
  });
  try {
    const id = engine.add([input], DEFAULT_OPTIONS, TRASH);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id, { intent: TRASH, inputs: [input] });
    await vi.waitFor(() => expect(engine.snapshot()[0]?.originalsChanges).toBeDefined(), { timeout: 10_000 });
    expect(engine.snapshot()[0]?.originalsChanges).toEqual({ missing: [], added: [], changed: [edited], unlisted: [] });
    expect(stages).toEqual(["verify", "recheck"]);
    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(edited, "utf8")).toBe("Alpha");
  } finally {
    await engine.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
