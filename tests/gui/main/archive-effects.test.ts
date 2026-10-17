import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createArchiveEffects, fileResources, type FileUse } from "../../../src/gui/main/archive-effects.js";
import { createQueueEngine, type EngineDeps, type QueueEngine } from "../../../src/gui/main/queue-engine.js";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import type { JobIntent } from "../../../src/gui/shared/queue.js";
import { ZipKit } from "../../../src/sdk/index.js";
import { createDirectoryLink, fileSymlinksSupported } from "../../helpers/symlink.js";
import { SAVE, TRASH } from "../../helpers/intents.js";
import { realPathState } from "../../helpers/archiveState.js";

const use = (location: string, mode: FileUse["mode"], identity: string | null = location): FileUse => ({ location, mode, identity });
it("claims the whole conflicting path set atomically, permits shared reads and independent work", () => {
  const owner = createArchiveEffects();
  const read = owner.claim([use("/source", "read")])!;
  expect(owner.claim([use("/source/file.zip", "read")])).not.toBeNull();
  expect(owner.claim([use("/unrelated", "change"), use("/source/file.zip", "change")])).toBeNull();
  expect(owner.claim([use("/unrelated", "change")])).not.toBeNull();
  read.release();
  expect(owner.claim([use("/alias", "change", "/source/file.zip")])).toBeNull();
});

it("retains an unknown effect through settlement despite a second finally release", async () => {
  const owner = createArchiveEffects();
  let settle!: () => void;
  const physical = new Promise<void>((resolve) => { settle = resolve; });
  const claim = owner.claim([use("/missing/Archive.zip", "change", null)])!;
  claim.release(physical); claim.release();
  expect(owner.claim([use("/missing/archive.zip", "change", null)])).toBeNull();
  settle(); await physical;
  expect(owner.claim([use("/missing/archive.zip", "change", null)])).not.toBeNull();
});

it.each([
  ["a short name", "/missing/PROGRA~1/a.zip", "/missing/Program Files/a.zip"],
  ["a trailing dot", "/missing/report.zip.", "/missing/report.zip"],
])("refuses missing outputs that %s may alias only on Windows", (_label, first, second) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const claimBoth = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    try {
      const owner = createArchiveEffects();
      owner.claim([{ ...use(first, "change", null), existingPrefix: "/" }]);
      return owner.claim([{ ...use(second, "change", null), existingPrefix: "/" }]);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  };
  expect(claimBoth("win32")).toBeNull();
  expect(claimBoth("darwin")).not.toBeNull();
});

it.each([["σ.zip", "ς.zip"], ["ß.zip", "ss.zip"], ["café.zip", "café.zip".normalize("NFD")]])(
  "retains a missing %s reservation across physical publication through %s", async (name, alias) => {
    const root = await mkdtemp(path.join(tmpdir(), "zipkit-missing-alias-"));
    const zip = new ZipKit();
    const owner = createArchiveEffects();
    const file = path.join(root, name), alternate = path.join(root, alias);
    let settle!: () => void;
    const physical = new Promise<void>((resolve) => { settle = resolve; });
    try {
      const resources = await fileResources([file], zip.volume());
      expect(resources[0]?.identity).toBeNull();
      const held = owner.claim(resources.map((resource) => ({ ...resource, mode: "change" as const })))!;
      held.release(physical);
      // A later job can resolve its resources before the abandoned native open
      // creates the first file. Both spellings then have no physical identity.
      const absent = (await fileResources([alternate], zip.volume())).map((resource) => ({ ...resource, mode: "change" as const }));
      expect(owner.claim(absent)).toBeNull();
      await writeFile(file, "pending claim");
      const later = (await fileResources([alternate], zip.volume())).map((resource) => ({ ...resource, mode: "change" as const }));
      expect(owner.claim(later)).toBeNull();
      settle(); await physical;
      expect(owner.claim(later)).not.toBeNull();
      expect(await readFile(file, "utf8")).toBe("pending claim");
    } finally { settle(); await physical; await rm(root, { recursive: true, force: true }); }
  },
);

it("permits missing outputs in physically distinct Unicode directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-distinct-namespace-"));
  const zip = new ZipKit();
  try {
    const a = path.join(root, "α"), b = path.join(root, "β");
    await mkdir(a); await mkdir(b);
    const owner = createArchiveEffects();
    const claims = await Promise.all([a, b].map((parent) => fileResources([path.join(parent, "archive.zip")], zip.volume())));
    expect(owner.claim(claims[0]!.map((resource) => ({ ...resource, mode: "change" as const })))).not.toBeNull();
    expect(owner.claim(claims[1]!.map((resource) => ({ ...resource, mode: "change" as const })))).not.toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-archive-effects-"));
  const trashDir = path.join(root, "trash");
  await mkdir(trashDir);
  const a = path.join(root, "a.txt"), b = path.join(root, "b.txt");
  await writeFile(a, "original A"); await writeFile(b, "original B");
  const zip = new ZipKit();
  let ids = 0, moves = 0;
  const deps: EngineDeps = {
    admission: new CommandAdmission(), effects: createArchiveEffects(),
    resources: (paths, signal) => fileResources(paths, zip.volume(signal)),
    plan: (inputs, options, signal) => zip.plan({ ...buildSpec(inputs, options), output: path.join(root, options.fileName || "same.zip") }, { signal }),
    write: async (plan, signal, onProgress, onPhysicalSettlement) =>
      (await zip.write(plan, { signal, onProgress, onPhysicalSettlement })).bytes,
    verify: async (archive, signal) => (await zip.extract({ archive, dryRun: true, checkMetadata: true }, { signal })).reportOk,
    checkRemoval: (archive, inputs, removed, options, signal, onProgress) =>
      zip.checkRemoval(buildSpec(inputs, options), archive, { removed, signal, onProgress }),
    classify: async (paths) => paths.map((path) => ({ path, kind: "file" as const })),
    trash: async (paths) => {
      for (const file of paths) await rename(file, path.join(trashDir, `${++moves}-${path.basename(file)}`));
      return { moved: paths, failed: [], unconfirmed: [] };
    },
    deleteOriginals: async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] }),
    pathState: realPathState,
    inspect: async (archive, signal, onProgress, checkMetadata) => {
      const data = await zip.extract({ archive, dryRun: true, checkMetadata }, { signal, onProgress });
      return { reportOk: data.reportOk, summary: data.summary, missing: data.missing, extra: data.extra };
    },
    emit: () => {}, progress: () => () => {}, newId: () => `job-${++ids}`, log: nullLog,
  };
  const engine = createQueueEngine(deps);
  const add = async (input: string, intent: JobIntent, fileName = "") => {
    const id = engine.add([input], { ...DEFAULT_OPTIONS, overwrite: true, fileName }, intent);
    await vi.waitFor(() => expect(engine.snapshot().find((job) => job.id === id)?.state).toBe("ready"));
    return id;
  };
  return { root, a, b, zip, deps, engine, add, output: path.join(root, "same.zip"),
    close: async () => { await engine.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
function run(engine: QueueEngine, id: string) {
  const job = engine.snapshot().find((job) => job.id === id)!;
  engine.run(id, { intent: job.intent, inputs: [...job.inputs] });
}
const terminal = (engine: QueueEngine, id: string, state: string) => vi.waitFor(() => expect(engine.snapshot().find((job) => job.id === id)?.state).toBe(state));

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
    await vi.waitFor(() => expect(older().history?.map((entry) => entry.message.key)).toContain("action.archiveReplaced"));
    await terminal(f.engine, a, "ready");
    expect(await readFile(f.output)).toEqual(published);
    expect(await readFile(f.a, "utf8")).toBe("original A");
    f.engine.removeOriginals(a, "trash");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(older().state).toBe("ready");
    expect(await readFile(f.a, "utf8")).toBe("original A");
  } finally { await f.close(); }
});

it("blocks replacement until an unconfirmed archive Trash physically settles, while disjoint work proceeds", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let physical: Promise<void> | undefined;
  try {
    const a = await f.add(f.a, SAVE); run(f.engine, a); await terminal(f.engine, a, "done");
    const original = await readFile(f.output);
    f.deps.trash = async (paths) => {
      physical = gate.then(() => rename(paths[0]!, path.join(f.root, "trash", "late.zip")));
      return { moved: [], failed: [], unconfirmed: paths, settlement: physical };
    };
    f.engine.removeArchive(a);
    await vi.waitFor(() => expect(f.engine.snapshot().find((job) => job.id === a)?.actionResult?.severity).toBe("warning"));
    const b = await f.add(f.b, SAVE); run(f.engine, b); await terminal(f.engine, b, "failed");
    expect(await readFile(f.output)).toEqual(original);
    const independent = await f.add(f.b, SAVE, "independent.zip");
    run(f.engine, independent); await terminal(f.engine, independent, "done");
    release(); await physical;
    run(f.engine, b); await terminal(f.engine, b, "done");
    expect(await readFile(f.output)).not.toEqual(original);
  } finally { release(); await physical; await f.close(); }
});

it.runIf(fileSymlinksSupported)("canonicalizes parent aliases for path claims and publication receipts", async () => {
  const f = await fixture();
  try {
    await f.zip.create({ inputs: [f.a], output: f.output });
    const alias = path.join(f.root, "alias");
    await createDirectoryLink(f.root, alias);
    const direct = await fileResources([f.output], f.zip.volume());
    const aliased = await fileResources([path.join(alias, "same.zip")], f.zip.volume());
    expect(aliased[0]).toEqual(direct[0]);
    const owner = createArchiveEffects();
    owner.claim(direct.map((resource) => ({ ...resource, mode: "change" })));
    expect(owner.claim(aliased.map((resource) => ({ ...resource, mode: "read" })))).toBeNull();
  } finally { await f.close(); }
});
