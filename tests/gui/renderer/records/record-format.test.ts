import { describe, expect, it } from "vitest";
import { cursorAfter, mergeNewestPage, recordDetails, recordKey } from "../../../../src/gui/renderer/src/records/record-format";
import type { RecordDetail, RecordSummary } from "../../../../src/gui/shared/records";

const row = (id: number, time: string, title = `row ${id}`): RecordSummary => ({
  kind: "log", id, session: "s", time, level: "info", title, text: null, jobId: null,
});

const a = row(1, "2026-10-02T08:00:01.000Z");
const b = row(2, "2026-10-02T08:00:02.000Z");
const c = row(3, "2026-10-02T08:00:03.000Z");
const d = row(4, "2026-10-02T08:00:04.000Z");
const keys = (records: RecordSummary[]) => records.map(recordKey);

describe("mergeNewestPage", () => {
  it("puts new records ahead of the rows shown and keeps the pages already read", () => {
    const merged = mergeNewestPage([c, b, a], true, { records: [d, c], more: true });
    expect(keys(merged.records)).toEqual(keys([d, c, b, a]));
    expect(merged.more).toBe(true);
  });

  it("takes the page's word on whether more follow when it reaches past every row shown", () => {
    expect(mergeNewestPage([b], true, { records: [c, b, a], more: false }).more).toBe(false);
  });

  it("loses nothing to an older page that arrives after a newer one", () => {
    const merged = mergeNewestPage([d, c, b, a], true, { records: [c, b], more: true });
    expect(keys(merged.records)).toEqual(keys([d, c, b, a]));
    expect(merged.more).toBe(true);
  });

  it("takes the page's copy of a row it shares with the list", () => {
    const fresh = { ...c, title: "fresh" };
    expect(mergeNewestPage([c], false, { records: [fresh], more: false }).records[0]!.title).toBe("fresh");
  });

  it("orders records of one instant as the database does: progress events after log lines, newest id first", () => {
    const event = { ...a, kind: "job-event" as const, id: 1 };
    const merged = mergeNewestPage([], false, { records: [event, { ...a, id: 5 }, { ...a, id: 6 }], more: false });
    expect(keys(merged.records)).toEqual(["log:6", "log:5", "job-event:1"]);
  });
});

describe("record helpers", () => {
  it("continues from the last row shown, or from the start", () => {
    expect(cursorAfter([c, b])).toEqual({ time: b.time, kind: "log", id: 2 });
    expect(cursorAfter([])).toBeNull();
  });

  const logLine = (fields: string, jobId: string | null = null): RecordDetail => ({
    kind: "log", id: 1, session: "s", time: "2026-10-02T08:00:01.000Z", level: "info", message: "m", jobId, fields,
  });
  const progress = (body: string): RecordDetail => ({
    kind: "job-event", id: 1, session: "s", time: "2026-10-02T08:00:01.000Z", seq: 1, jobId: "job-1",
    event: "plan.done", level: "info", body,
  });

  it("indents stored JSON and leaves other text as it is", () => {
    expect(recordDetails(logLine('{"a":1}'))).toBe('{\n  "a": 1\n}');
    expect(recordDetails(logLine("not json"))).toBe("not json");
  });

  it("has no details for an empty value", () => {
    for (const empty of ["{}", "null", "[]", '""', '"  "', "", "  \n "]) {
      expect(recordDetails(logLine(empty)), empty).toBeNull();
    }
  });

  it("leaves out what the pane already shows, and nothing else", () => {
    expect(recordDetails(logLine('{"jobId":"job-1","archive":"/a.zip"}', "job-1"))).toBe(
      JSON.stringify({ archive: "/a.zip" }, null, 2),
    );
    expect(recordDetails(logLine('{"jobId":"job-1"}', "job-1"))).toBeNull();
    expect(recordDetails(logLine('{"jobId":7}'))).toBe(JSON.stringify({ jobId: 7 }, null, 2));
    expect(
      recordDetails(progress(JSON.stringify({
        time: "2026-10-02T08:00:01.000Z", message: "plan complete", stage: "plan", level: "info", event: "plan.done", total: 2,
      }))),
    ).toBe(JSON.stringify({ message: "plan complete", stage: "plan", total: 2 }, null, 2));
    expect(
      recordDetails(progress(JSON.stringify({ time: "2026-10-02T08:00:01.000Z", level: "info", event: "plan.done" }))),
    ).toBeNull();
    expect(recordDetails(progress(JSON.stringify({ level: "warn", event: "other" })))).toBe(
      JSON.stringify({ level: "warn", event: "other" }, null, 2),
    );
  });
});
