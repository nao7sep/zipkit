import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createQueueEngine, type EngineDeps, type QueueEngine } from "../../../src/gui/main/queue-engine.js";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import type { JobIntent } from "../../../src/gui/shared/queue.js";
import { ZipKit } from "zipkitsdk";
import { createSdk } from "../../../src/gui/main/sdk.js";
import { SAVE, TRASH } from "../../helpers/intents.js";
import { realPathState } from "../../helpers/archiveState.js";
import { eventually } from "../../helpers/eventually.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-archive-ownership-"));
  const trashDir = path.join(root, "trash");
  await mkdir(trashDir);
  const a = path.join(root, "a.txt"), b = path.join(root, "b.txt");
  await writeFile(a, "original A"); await writeFile(b, "original B");
  let ids = 0, moves = 0;
  const toTrash = (file: string) => rename(file, path.join(trashDir, `${++moves}-${path.basename(file)}`));
  const zip = new ZipKit({ trash: toTrash });
  const sdk = createSdk(zip);
  const deps: EngineDeps = {
    admission: new CommandAdmission(),
    plan: (inputs, options, signal) => zip.plan({ ...buildSpec(inputs, options), output: path.join(root, options.fileName || "same.zip") }, { signal }),
    write: async (plan, signal, onEvent) =>
      ((w) => (w.mode === "write" ? w.bytes : null))(await zip.write(plan, { signal, onEvent })),
    verify: async (archive, signal) => (await zip.verify({ archive, manifest: true }, { signal })).ok,
    removeOriginals: (archive, inputs, removed, options, method, signal, onEvent) =>
      sdk.removeOriginals(archive, inputs, removed, options, method, { signal, onEvent }),
    pathKinds: async (paths) => paths.map((path) => ({ path, kind: "file" as const })),
    trash: async (paths) => {
      for (const file of paths) await toTrash(file);
      return { moved: paths, failed: [] };
    },
    pathState: realPathState,
    inspect: async (archive, signal, onEvent, manifestName) => {
      const data = await zip.verify(manifestName === null ? { archive } : { archive, manifest: true, manifestName }, { signal, onEvent });
      return { ok: data.ok, summary: data.summary, missing: data.missing, extra: data.extra };
    },
    emit: () => {}, progress: () => () => {}, newId: () => `job-${++ids}`, log: nullLog,
  };
  const engine = createQueueEngine(deps);
  const add = async (input: string, intent: JobIntent, fileName = "") => {
    const id = engine.add([input], { ...DEFAULT_OPTIONS, overwrite: true, fileName }, intent);
    await eventually(() => expect(engine.snapshot().find((job) => job.id === id)?.state).toBe("ready"));
    return id;
  };
  return { root, a, b, zip, deps, engine, add, output: path.join(root, "same.zip"),
    close: async () => { await engine.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
function run(engine: QueueEngine, id: string) {
  const job = engine.snapshot().find((job) => job.id === id)!;
  engine.run(id, { intent: job.intent, inputs: [...job.inputs] });
}
const terminal = (engine: QueueEngine, id: string, state: string) => eventually(() => expect(engine.snapshot().find((job) => job.id === id)?.state).toBe(state));

it("refuses an older job's archive removal after a real later job overwrites it and moves its originals", async () => {
  const f = await fixture();
  try {
    const a = await f.add(f.a, SAVE); run(f.engine, a); await terminal(f.engine, a, "done");
    const b = await f.add(f.b, TRASH); run(f.engine, b); await terminal(f.engine, b, "done");
    const published = await readFile(f.output);
    f.engine.removeArchive(a);
    // The file there is the later job's, so the older job leaves it alone, says
    // so, and goes back to be created again; its originals stay untouched.
    const older = () => f.engine.snapshot().find((job) => job.id === a)!;
    await eventually(() => expect(older().history?.map((entry) => entry.message.key)).toContain("action.archiveReplaced"));
    await terminal(f.engine, a, "ready");
    expect(await readFile(f.output)).toEqual(published);
    expect(await readFile(f.a, "utf8")).toBe("original A");
    f.engine.removeOriginals(a, "trash");
    expect(older().state).toBe("ready");
    expect(await readFile(f.a, "utf8")).toBe("original A");
  } finally { await f.close(); }
});
