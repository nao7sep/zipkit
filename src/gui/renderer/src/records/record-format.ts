/**
 * Pure helpers for the Records window: how a record is keyed, labelled and
 * paged, and how a re-read newest page joins the rows already shown. No React,
 * no DOM.
 */

import type { MessageKey } from "../../../shared/i18n/catalogues";
import type {
  RecordCursor,
  RecordDetail,
  RecordKind,
  RecordLevel,
  RecordLevelFilter,
  RecordsPage,
  RecordSummary,
} from "../../../shared/records";

export function recordKey(record: { kind: RecordKind; id: number }): string {
  return `${record.kind}:${record.id}`;
}

/** The values the detail pane already shows beside the Details block, by the
 *  key they are stored under: a progress event's body is the SDK's whole log
 *  line, so its time, level and event name are shown above it, and a log line's
 *  job id is shown as its Job field. */
function shownValues(record: RecordDetail): Record<string, unknown> {
  return record.kind === "log"
    ? { jobId: record.jobId }
    : { time: record.time, level: record.level, event: record.event };
}

function isEmpty(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** A record's Details block text: its stored JSON, indented, without the
 *  values the pane already shows; text that is not JSON as it is. `null` when
 *  nothing is left to show, so the block is left out. */
export function recordDetails(record: RecordDetail): string | null {
  const text = record.kind === "log" ? record.fields : record.body;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text.trim() === "" ? null : text;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const shown = shownValues(record);
    value = Object.fromEntries(
      Object.entries(value).filter(([key, v]) => !(Object.hasOwn(shown, key) && shown[key] !== null && shown[key] === v)),
    );
  }
  return isEmpty(value) ? null : JSON.stringify(value, null, 2);
}

export const KIND_LABELS: Record<RecordKind, MessageKey> = {
  log: "records.kindLog",
  "job-event": "records.kindJobEvent",
};

export const LEVEL_LABELS: Record<RecordLevel, MessageKey> = {
  error: "log.error",
  warn: "log.warn",
  info: "log.info",
  debug: "log.debug",
};

export const LEVEL_FILTER_LABELS: Record<RecordLevelFilter, MessageKey> = {
  attention: "records.levelAttention",
  ...LEVEL_LABELS,
};

/** A level's pill: only the levels worth stopping at take a status colour. */
export const LEVEL_PILLS: Record<RecordLevel, string> = {
  error: "records-pill records-pill--error",
  warn: "records-pill records-pill--warn",
  info: "records-pill",
  debug: "records-pill",
};

/** The page after the last record shown. */
export function cursorAfter(records: readonly RecordSummary[]): RecordCursor | null {
  const last = records.at(-1);
  return last === undefined ? null : { time: last.time, kind: last.kind, id: last.id };
}

// The order the list shows records in, newest first; the database pages them
// the same way.
function newestFirst(a: RecordSummary, b: RecordSummary): number {
  if (a.time !== b.time) return a.time < b.time ? 1 : -1;
  if (a.kind !== b.kind) return a.kind < b.kind ? 1 : -1;
  return b.id - a.id;
}

/** The newest page read again, joined with the rows already shown: a row in
 *  both takes the page's copy, and the rows shown beyond the page stay, so the
 *  pages already read are kept and a page read out of order loses nothing. */
export function mergeNewestPage(
  shown: readonly RecordSummary[],
  shownMore: boolean,
  page: RecordsPage,
): { records: RecordSummary[]; more: boolean } {
  const byKey = new Map(shown.map((record) => [recordKey(record), record]));
  for (const record of page.records) byKey.set(recordKey(record), record);
  const records = [...byKey.values()].sort(newestFirst);
  const last = page.records.at(-1);
  const beyond = last !== undefined && shown.some((record) => newestFirst(record, last) > 0);
  return { records, more: beyond ? shownMore : page.more };
}
