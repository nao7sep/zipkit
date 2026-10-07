import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readConfigText, readSavedPreference } from "../../../src/gui/main/i18n.js";
import { managedIO, MANAGED_IO_WAIT_MS } from "../../../src/gui/main/managed-io.js";
const controls = vi.hoisted(() => ({ file: "", entered: null as (() => void) | null, held: null as Promise<void> | null }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]) === controls.file) { controls.entered?.(); await controls.held; }
    return actual.readFile(...args);
  } };
});

it("a held language preference read settles as System within its bound without changing stored bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-language-read-"));
  const file = path.join(root, "config.json");
  const text = '{"formatVersion":1,"language":"fr"}';
  await writeFile(file, text);
  controls.file = file;
  let release!: () => void;
  controls.held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { controls.entered = resolve; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const reading = readConfigText(file);
    await entered;
    await vi.advanceTimersByTimeAsync(MANAGED_IO_WAIT_MS);
    expect(readSavedPreference(await reading)).toBe("system");
    release();
    await managedIO(file, async () => {});
    controls.file = "";
    expect(await readFile(file, "utf8")).toBe(text);
  } finally {
    release();
    vi.useRealTimers();
    await managedIO(file, async () => {});
    controls.file = "";
    await rm(root, { recursive: true, force: true });
  }
});
