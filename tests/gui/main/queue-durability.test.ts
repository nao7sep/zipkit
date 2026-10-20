import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createQueueEngine } from "../../../src/gui/main/queue-engine.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { createPathClaims } from "zipkitsdk";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { createTranslator } from "../../../src/gui/shared/i18n/translate.js";
import { ZipKit } from "zipkitsdk";
import { nodeFileSystem, Volume } from "zipkitsdk/testing";
import { TRASH } from "../../helpers/intents.js";
import { realPathState } from "../../helpers/archiveState.js";

it("presents a real publication flush failure safely and keeps originals out of Trash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-queue-durability-"));
  const input = path.join(root, "source.txt"), output = path.join(root, "archive.zip");
  const failure = Object.assign(new Error("EIO /private/staging SENTINEL_SECRET"), { code: "EIO" });
  class FailingZipKit extends ZipKit {
    override volume(signal?: AbortSignal) {
      return new Volume({ ...nodeFileSystem, syncDirectory: async () => { throw failure; } }, 30_000, signal);
    }
  }
  const zip = new FailingZipKit();
  const trash = vi.fn(async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] }));
  const logged = vi.fn();
  const engine = createQueueEngine({
    admission: new CommandAdmission(), effects: createPathClaims(),
    resources: (paths, signal) => zip.pathResources(paths, { signal: signal }),
    plan: (inputs, options, signal) => zip.plan({ ...buildSpec(inputs, options), output }, { signal }),
    write: async (plan, signal, onEvent, onPhysicalSettlement) =>
      ((w) => (w.mode === "write" ? w.bytes : null))(await zip.write(plan, { signal, onEvent, onPhysicalSettlement })),
    verify: async (archive, signal) => (await zip.verify({ archive, manifest: true }, { signal })).ok,
    checkRemoval: (archive, inputs, removed, options, signal, onEvent) =>
      zip.checkRemoval({ spec: buildSpec(inputs, options), archive, removed }, { signal, onEvent }),
    pathKinds: async (paths) => paths.map((location) => ({ path: location, kind: "file" as const })),
    deleteOriginals: async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] }),
    pathState: realPathState,
    inspect: async (archive, signal, onEvent, manifestName) => {
      const data = await zip.verify(manifestName === null ? { archive } : { archive, manifest: true, manifestName }, { signal, onEvent });
      return { ok: data.ok, summary: data.summary, missing: data.missing, extra: data.extra };
    },
    trash, emit: () => {}, progress: () => () => {},
    newId: () => "job", log: { ...nullLog, error: logged },
  });
  try {
    await writeFile(input, "preserved original");
    const id = engine.add([input], DEFAULT_OPTIONS, TRASH);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id, { intent: TRASH, inputs: [input] });
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    const job = engine.snapshot()[0]!;
    const copy = createTranslator("en").text(job.message!);
    expect(copy).toContain(output);
    expect(copy).toContain("originals");
    expect(copy).toContain("could not confirm that the save was synchronized to disk");
    expect(copy).not.toMatch(/EIO|\/private\/staging|SENTINEL_SECRET|WriteError/);
    expect(logged).toHaveBeenCalledWith("job write failed", expect.objectContaining({
      error: expect.objectContaining({ code: "write.durability", cause: expect.objectContaining({ message: failure.message, code: "EIO" }) }),
    }));
    expect(job.archiveWritten).toBe(false);
    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(input, "utf8")).toBe("preserved original");
    expect((await new ZipKit().verify({ archive: output, manifest: true })).ok).toBe(true);
  } finally { await engine.shutdown(); await rm(root, { recursive: true, force: true }); }
});
