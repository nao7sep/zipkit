import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createQueueEngine } from "../../../src/gui/main/queue-engine.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { createPathClaims } from "zipkitsdk";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { ZipKit } from "zipkitsdk";
import { TRASH } from "../../helpers/intents.js";
import { realPathState } from "../../helpers/archiveState.js";

it("keeps originals when a real archive's file type changes after publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-queue-type-"));
  const input = path.join(root, "source.txt"), output = path.join(root, "archive.zip");
  await writeFile(input, "target.txt");
  const zip = new ZipKit();
  const trash = vi.fn(async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] }));
  const engine = createQueueEngine({
    admission: new CommandAdmission(),
    effects: createPathClaims(),
    resources: (paths, signal) => zip.pathResources(paths, { signal: signal }),
    plan: (inputs, options, signal) => zip.plan({ ...buildSpec(inputs, options), output }, { signal }),
    write: async (plan, signal, onEvent, onPhysicalSettlement) => {
      const result = await zip.write(plan, { signal, onEvent, onPhysicalSettlement });
      const bytes = await readFile(output);
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
      await writeFile(output, bytes);
      return result.bytes;
    },
    verify: async (archive, signal) => (await zip.extract({ archive, dryRun: true, checkMetadata: true }, { signal })).reportOk,
    checkRemoval: (archive, inputs, removed, options, signal, onEvent) =>
      zip.checkRemoval(buildSpec(inputs, options), archive, { removed, signal, onEvent }),
    classify: async (paths) => paths.map((path) => ({ path, kind: "file" as const })),
    deleteOriginals: async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] }),
    pathState: realPathState,
    inspect: async (archive, signal, onEvent, checkMetadata) => {
      const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { signal, onEvent });
      return { reportOk: data.reportOk, summary: data.summary, missing: data.missing, extra: data.extra };
    },
    trash, emit: () => {}, progress: () => () => {}, newId: () => "job", log: nullLog,
  });
  try {
    const id = engine.add([input], DEFAULT_OPTIONS, TRASH);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id, { intent: TRASH, inputs: [input] });
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(input, "utf8")).toBe("target.txt");
  } finally {
    await engine.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
