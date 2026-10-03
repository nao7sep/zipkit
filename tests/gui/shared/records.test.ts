import { describe, expect, it } from "vitest";
import { RECORD_LEVEL_FILTERS, parseRecordsQuery } from "../../../src/gui/shared/records.js";

const ALL = { session: null, kind: null, level: null, search: "", after: null };

describe("parseRecordsQuery", () => {
  it("accepts every filter off, and every filter the window offers", () => {
    expect(parseRecordsQuery(ALL)).toEqual(ALL);
    const query = {
      session: "2026-06-15T01:00:00.000Z",
      kind: "job-event",
      level: "attention",
      search: "zip",
      after: { time: "2026-06-15T01:00:01.000Z", kind: "log", id: 7 },
    };
    expect(parseRecordsQuery(query)).toEqual(query);
  });

  it("offers Needs attention first, then each level from the loudest", () => {
    expect(RECORD_LEVEL_FILTERS).toEqual(["attention", "error", "warn", "info", "debug"]);
  });

  it("refuses anything else, field by field", () => {
    expect(() => parseRecordsQuery(null)).toThrow(/object/);
    expect(() => parseRecordsQuery({ ...ALL, session: 3 })).toThrow(/session/);
    expect(() => parseRecordsQuery({ ...ALL, kind: "provider-call" })).toThrow(/kind/);
    expect(() => parseRecordsQuery({ ...ALL, level: "fatal" })).toThrow(/level/);
    expect(() => parseRecordsQuery({ ...ALL, search: undefined })).toThrow(/search/);
    expect(() => parseRecordsQuery({ ...ALL, after: { time: "t", kind: "log", id: 1.5 } })).toThrow(/after/);
    expect(() => parseRecordsQuery({ ...ALL, after: "t" })).toThrow(/after/);
  });

  it("keeps only the fields it knows", () => {
    expect(parseRecordsQuery({ ...ALL, extra: "x", after: { time: "t", kind: "log", id: 1, more: 2 } })).toEqual({
      ...ALL,
      after: { time: "t", kind: "log", id: 1 },
    });
  });
});
