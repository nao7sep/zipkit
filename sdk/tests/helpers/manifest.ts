import { readZipFile } from "./readZip.ts";

/** The manifest embedded in an archive, parsed whole, for tests that pin what it says. */
export function readManifest(archive: string, name = "zipkit.json"): Record<string, unknown> {
  const entry = readZipFile(archive).entries.find((e) => e.name === name);
  if (!entry) throw new Error(`no ${name} in ${archive}`);
  return JSON.parse(entry.content.toString("utf8")) as Record<string, unknown>;
}
