import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function detectFileSymlinkSupport(): Promise<boolean> {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-symlink-probe-"));
  try {
    const target = path.join(root, "target.txt");
    await writeFile(target, "probe");
    await symlink(target, path.join(root, "link.txt"), "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return false;
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const fileSymlinksSupported = await detectFileSymlinkSupport();

export async function createFileLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, "file");
}

export async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  const linkTarget = process.platform === "win32"
    ? path.resolve(path.dirname(linkPath), target)
    : target;
  await symlink(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
}
