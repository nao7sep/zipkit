/**
 * Reads an embedded manifest as it is inflated, one entry record at a time, so
 * verifying a very large folder never holds the manifest's text or its parsed
 * document whole (volume-handling conventions, Data size): only the compact
 * records verification compares stay. No size limit applies; the data's own
 * length and CRC-32 are checked as every entry's are.
 */

import parser from "stream-json/core/parser.js";
import Assembler from "stream-json/core/assembler.js";
import { getManyValues, isMany, none } from "stream-chain/defs.js";
import type { Token } from "stream-json/core/parser.js";

/** What reading found: the format version as written, the records, and the
 *  first problem with the document's shape, decided by the caller in order. */
export interface ManifestReading {
  formatVersion: unknown;
  /** False when `entries` was absent or not a list. */
  hasEntries: boolean;
  records: unknown[];
  /** The first record that failed `accept`, with its reason. */
  problem: string | null;
}

/** Feed the manifest's bytes in order; `finish` resolves the reading or throws
 *  when the bytes are not one JSON object. `accept` checks and compacts a
 *  record, returning a reason it is refused or the record to keep. */
export type AcceptRecord = (record: unknown) => { keep: unknown } | { refuse: string };

export function createManifestReader(accept: AcceptRecord) {
  const parse = parser({ streamValues: false });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reading: ManifestReading = { formatVersion: undefined, hasEntries: false, records: [], problem: null };
  // 0 before the root object, 1 inside it, 2 inside its `entries` list.
  let depth = 0;
  let closed = false;
  let key: string | null = null;
  let record: Assembler | null = null;
  // Open containers of a value this reader does not need, skipped unparsed.
  let skipping = 0;

  const opens = (token: Token): boolean => token.name === "startObject" || token.name === "startArray";
  const closes = (token: Token): boolean => token.name === "endObject" || token.name === "endArray";

  function take(value: unknown): void {
    if (reading.problem !== null) return;
    const outcome = accept(value);
    if ("refuse" in outcome) reading.problem = outcome.refuse;
    else reading.records.push(outcome.keep);
  }

  function consume(token: Token): void {
    if (record) {
      record.consume(token);
      if (record.done) { take(record.current); record = null; }
      return;
    }
    if (skipping > 0) {
      if (opens(token)) skipping++;
      else if (closes(token)) skipping--;
      return;
    }
    if (closed) throw new SyntaxError("text follows the manifest's object");
    if (depth === 0) {
      if (token.name !== "startObject") throw new SyntaxError("the manifest is not a JSON object");
      depth = 1;
      return;
    }
    if (depth === 1) {
      if (token.name === "keyValue") { key = token.value; return; }
      if (token.name === "endObject") { closed = true; depth = 0; return; }
      if (key === "entries" && token.name === "startArray") {
        reading.hasEntries = true;
        depth = 2;
      } else {
        if (key === "formatVersion") reading.formatVersion = token.name === "numberValue" ? Number(token.value) : null;
        if (key === "entries") reading.hasEntries = false;
        if (opens(token)) skipping = 1;
      }
      key = null;
      return;
    }
    if (token.name === "endArray") { depth = 1; return; }
    if (token.name === "startObject") {
      record = new Assembler();
      record.consume(token);
      return;
    }
    // A record that is not an object.
    take(token.name === "startArray" ? [] : "value" in token ? token.value : null);
    if (opens(token)) skipping = 1;
  }

  async function feed(text: string | typeof none): Promise<void> {
    const out: unknown = parse(text as string);
    if (out === none) return;
    // The parser hands back its tokens for each piece as an iterable, async in
    // the package's current builds.
    if (out !== null && typeof out === "object" && Symbol.asyncIterator in out) {
      for await (const token of out as AsyncIterable<Token>) consume(token);
    } else if (isMany(out)) {
      for (const token of getManyValues(out) as Token[]) consume(token);
    } else {
      consume(out as Token);
    }
  }

  return {
    async push(chunk: Buffer): Promise<void> {
      await feed(decoder.decode(chunk, { stream: true }));
    },
    async finish(): Promise<ManifestReading> {
      const rest = decoder.decode();
      if (rest !== "") await feed(rest);
      await feed(none);
      if (!closed) throw new SyntaxError("the manifest ends before its object closes");
      return reading;
    },
  };
}
