import { describe, expect, it } from "vitest";
import { createManifestReader, type AcceptRecord } from "../../src/read/manifestReader.ts";

const keepAll: AcceptRecord = (record) => ({ keep: record });

/** Feed `text` in pieces of `size` bytes, so values and UTF-8 sequences split. */
async function read(text: string, size: number, accept: AcceptRecord = keepAll) {
  const reader = createManifestReader(accept);
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length; at += size) await reader.push(bytes.subarray(at, at + size));
  return reader.finish();
}

describe("createManifestReader", () => {
  const doc = {
    about: "x", formatVersion: 1, policy: { exclusions: [{ pattern: "*.tmp" }] },
    entries: [{ archivePath: "café/é.txt", size: 3, mtime: { ns: "1" } }, { archivePath: "b", size: 0, mtime: { ns: "2" } }],
    excluded: [{ archivePath: "x", reason: "pattern .DS_Store" }],
    findings: [{ rule: "r", message: "m" }],
  };

  it.each([1, 3, 7, 4096])("reads the format version and every record, fed %i bytes at a time", async (size) => {
    const reading = await read(JSON.stringify(doc, null, 2), size);
    expect(reading.formatVersion).toBe(1);
    expect(reading.hasEntries).toBe(true);
    expect(reading.records).toEqual(doc.entries);
    expect(reading.problem).toBeNull();
  });

  it("keeps only what accept keeps and reports the first refusal", async () => {
    let seen = 0;
    const reading = await read(JSON.stringify(doc), 5, (record) => (++seen === 2 ? { refuse: "second is bad" } : { keep: (record as { archivePath: string }).archivePath }));
    // Nothing after the first refusal is kept or asked about.
    expect(reading.records).toEqual(["café/é.txt"]);
    expect(reading.problem).toBe("second is bad");
    expect(seen).toBe(2);
  });

  it("reports a record that is not an object, and entries that are not a list", async () => {
    expect((await read(JSON.stringify({ formatVersion: 1, entries: [5] }), 4, (r) => (typeof r === "object" ? { keep: r } : { refuse: "not an object" }))).problem).toBe("not an object");
    const nested = await read(JSON.stringify({ formatVersion: 1, entries: [[1, [2]], { archivePath: "after" }] }), 3);
    expect(nested.records).toEqual([[], { archivePath: "after" }]);
    expect((await read(JSON.stringify({ formatVersion: 1, entries: {} }), 4)).hasEntries).toBe(false);
    expect((await read(JSON.stringify({ formatVersion: "1", entries: [] }), 4)).formatVersion).toBeNull();
  });

  it.each(["[]", "{\"entries\": [", "{} {}", "{\"a\": tru}"])("refuses text that is not one JSON object: %s", async (text) => {
    await expect(read(text, 2)).rejects.toThrow();
  });

  it("refuses bytes that are not UTF-8", async () => {
    const reader = createManifestReader(keepAll);
    await expect(reader.push(Buffer.from([0x7b, 0xff, 0x7d]))).rejects.toThrow();
  });
});
