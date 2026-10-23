import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ZipKit } from "../src/index.ts";
import type { PlanData } from "../src/types.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-handoff-")); });
afterEach(() => rm(root, { recursive: true, force: true }));
const mutations: [string, (p: PlanData) => void][] = [
  ["relative source", p => { p.instructions.entries[0]!.absolutePath = "relative"; }],
  ["traversing archive path", p => { p.instructions.entries[0]!.archivePath = "../escape"; }],
  ["bad policy", p => { p.instructions.policy.compression.level = 99; }],
  ["incomplete policy", p => { delete (p.instructions.policy as Partial<typeof p.instructions.policy>).names; }],
  ["nondecimal timestamp", p => { p.instructions.entries[0]!.mtimeNs = "not-a-number"; }],
  ["unrepresentable timestamp", p => { p.instructions.entries[0]!.atimeNs = "99999999999999999999999999999999999999"; }],
  ["nested findings disagree", p => { p.entries[0]!.findings.push({ id: "x", rule: "name.suspicious", severity: "warning", path: "a.txt", message: "hidden" }); }],
  ["bad timezone", p => { p.instructions.timeZone = "Not/AZone"; }],
  ["verification rule as name fix", p => { p.instructions.entries[0]!.nameFixes = [{ rule: "verify.crc32-mismatch" as never, before: "a", after: "b" }]; p.entries[0]!.nameFixes = p.instructions.entries[0]!.nameFixes; }],
  ["unrepresentable unix mode", p => { p.instructions.entries[0]!.mode = 0x10000; }],
  ["bad name fix", p => { p.instructions.entries[0]!.nameFixes = [null as never]; }],
  ["missing symlink target", p => { p.instructions.entries[0]!.type = "symlink"; }],
  ["directory compression", p => { p.instructions.entries[0]!.type = "dir"; p.instructions.entries[0]!.method = "deflate"; }],
  ["visible path", p => { p.entries[0]!.archivePath = "shown.txt"; }],
  ["visible exclusion", p => { p.entries[0]!.excluded = true; }],
  ["visible method", p => { p.entries[0]!.method = "store"; }],
  ["visible type", p => { p.entries[0]!.type = "dir"; }],
  ["missing visible entries", p => { p.entries = []; }],
  ["missing instructions", p => { p.instructions.entries = []; }],
  ["bad summary", p => { p.summary.included = 100; }],
  ["malformed findings", p => { p.findings = [null as never]; }],
];
it.each(mutations)("rejects %s before output creation", async (_name, mutate) => {
  const input = path.join(root, "a.txt");
  await writeFile(input, "alpha");
  const zip = new ZipKit();
  const plan: PlanData = JSON.parse(JSON.stringify(await zip.plan({ inputs: [input], output: path.join(root, "out.zip") })));
  mutate(plan);
  await expect(zip.write(plan)).rejects.toMatchObject({ code: "plan.invalid", effect: "none" });
  expect(await readdir(root)).toEqual(["a.txt"]);
});

it.each(["parent", "PARENT"])("rejects a transferred plan with file %s and its descendant before output creation", async (parent) => {
  const inputs = [path.join(root, "a.txt"), path.join(root, "b.txt")];
  await writeFile(inputs[0]!, "alpha");
  await writeFile(inputs[1]!, "beta");
  const zip = new ZipKit();
  const plan: PlanData = JSON.parse(JSON.stringify(await zip.plan({ inputs, output: path.join(root, "out.zip") })));
  expect(plan.writable).toBe(true);
  for (const [index, archivePath] of [parent, "parent/child"].entries()) {
    plan.instructions.entries[index]!.archivePath = archivePath;
    plan.entries[index]!.archivePath = archivePath;
  }

  await expect(zip.write(plan)).rejects.toMatchObject({ code: "plan.invalid", effect: "none" });
  expect((await readdir(root)).sort()).toEqual(["a.txt", "b.txt"]);
});

it("executes JSON and structured-clone plans unchanged", async () => {
  const input = path.join(root, "a.txt");
  await writeFile(input, "alpha");
  const zip = new ZipKit();
  for (const clone of [structuredClone, (p: PlanData): PlanData => JSON.parse(JSON.stringify(p))]) {
    const plan = clone(await zip.plan({ inputs: [input], output: path.join(root, "out.zip"), overwrite: true }));
    expect(await zip.write(plan)).toMatchObject({ mode: "write" });
    expect((await zip.verify({ archive: plan.output, manifest: true })).ok).toBe(true);
  }
});

it.skipIf(process.platform === "win32")("keeps original provenance, multiple inputs, excluded entries and followed links writable", async () => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const folder = path.join(root, "C:");
  await mkdir(folder);
  await writeFile(path.join(folder, "a.txt"), "alpha");
  await writeFile(path.join(folder, ".DS_Store"), "excluded");
  const alias = path.join(root, "alias.txt");
  await symlink(path.join(folder, "a.txt"), alias);
  const zip = new ZipKit();
  const plan = JSON.parse(JSON.stringify(await zip.plan({ inputs: [folder, alias], output: path.join(root, "out.zip") })));
  expect(plan.entries.some((e: { excluded: boolean }) => e.excluded)).toBe(true);
  expect(await zip.write(plan)).toMatchObject({ mode: "write" });
  expect((await zip.verify({ archive: plan.output, manifest: true })).ok).toBe(true);
});

it("writes JSON plans for multiple inputs with excluded entries", async () => {
  const { mkdir } = await import("node:fs/promises");
  const folder = path.join(root, "folder");
  await mkdir(folder);
  await writeFile(path.join(folder, "a.txt"), "alpha");
  await writeFile(path.join(folder, ".DS_Store"), "excluded");
  const second = path.join(root, "b.txt");
  await writeFile(second, "beta");
  const zip = new ZipKit();
  const plan = JSON.parse(JSON.stringify(await zip.plan({ inputs: [folder, second], output: path.join(root, "out.zip") })));
  expect(plan.entries.some((e: { excluded: boolean }) => e.excluded)).toBe(true);
  expect(await zip.write(plan)).toMatchObject({ mode: "write" });
});
