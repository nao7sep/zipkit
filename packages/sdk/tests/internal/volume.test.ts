import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../../src/sdk/internal/volume.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zipkit-volume-mode-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const volume = (port: FileSystemPort = nodeFileSystem): Volume => new Volume(port, 30_000);

describe("ordinary staging and replacement modes", () => {
  it.skipIf(process.platform === "win32")("stages with owner access before bytes and restores the ordinary new-file mode before publication", async () => {
    const temp = path.join(root, "stage.tmp");
    const owner = volume();
    const handle = await owner.createTemp(temp);
    try {
      expect((await stat(temp)).mode & 0o777).toBe(0o600 & ~process.umask());
      await handle.writeAll(Buffer.from("complete"), 0);
    } finally { await handle.close(); }
    await owner.prepareNewMode(temp);
    expect((await stat(temp)).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("an exclusive staging collision leaves the other file intact", async () => {
    const temp = path.join(root, "stage.tmp");
    await writeFile(temp, "other");
    await expect(volume().createTemp(temp)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(temp, "utf8")).toBe("other");
  });

  it.skipIf(process.platform === "win32")("keeps an existing target's ordinary permission bits", async () => {
    const target = path.join(root, "target");
    const temp = path.join(root, "stage.tmp");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    const owner = volume();
    const handle = await owner.createTemp(temp);
    await handle.close();
    expect(await owner.keepMode(target, temp)).toBe(true);
    expect((await stat(temp)).mode & 0o777).toBe(0o640);
  });

  it.each(["EPERM", "EACCES", "EIO"])("propagates %s while preparing replacement permissions", async (code) => {
    const target = path.join(root, "target");
    await writeFile(target, "old");
    const error = Object.assign(new Error("mode failed"), { code });
    const owner = volume({ ...nodeFileSystem, chmod: async () => { throw error; } });
    await expect(owner.keepMode(target, path.join(root, "stage.tmp"))).rejects.toBe(error);
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it.each(["ENOSYS", "ENOTSUP", "EOPNOTSUPP"])("tolerates explicit %s mode incapability", async (code) => {
    const target = path.join(root, "target");
    await writeFile(target, "old");
    const owner = volume({ ...nodeFileSystem, chmod: async () => { throw Object.assign(new Error("unsupported"), { code }); } });
    await expect(owner.keepMode(target, path.join(root, "stage.tmp"))).resolves.toBe(true);
    await expect(owner.prepareNewMode(path.join(root, "stage.tmp"))).resolves.toBeUndefined();
  });

  it("does not treat a target stat failure as an absent file", async () => {
    const error = Object.assign(new Error("read denied"), { code: "EACCES" });
    const owner = volume({ ...nodeFileSystem, stat: async () => { throw error; } });
    await expect(owner.keepMode(path.join(root, "target"), path.join(root, "stage.tmp"))).rejects.toBe(error);
  });
});
