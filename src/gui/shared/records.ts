/**
 * What the Records window reads from `records.sqlite3`: a filtered page of
 * summaries, newest first, and one record whole. The database holds two kinds
 * of record, the app's own log lines and each job's SDK progress events; JSON
 * fields arrive as the text the database holds, and the window decides how to
 * show them. Pure, so both processes and the tests share it.
 */

export type RecordKind = "log" | "job-event";

export type RecordLevel = "debug" | "info" | "warn" | "error";

export const RECORD_KINDS: readonly RecordKind[] = ["log", "job-event"];

export const RECORD_LEVELS: readonly RecordLevel[] = ["error", "warn", "info", "debug"];

/** What the level filter offers: a record's own level, or `attention`, every
 *  record at `warn` or `error`. */
export type RecordLevelFilter = "attention" | RecordLevel;

export const RECORD_LEVEL_FILTERS: readonly RecordLevelFilter[] = ["attention", ...RECORD_LEVELS];

/** How many summaries one page holds. */
export const RECORDS_PAGE_SIZE = 100;

/** Where the next page starts: the last summary of the page before it. */
export interface RecordCursor {
  time: string;
  kind: RecordKind;
  id: number;
}

export interface RecordsQuery {
  /** A launch, named by its session. */
  session: string | null;
  kind: RecordKind | null;
  level: RecordLevelFilter | null;
  search: string;
  after: RecordCursor | null;
}

export interface RecordSummary {
  kind: RecordKind;
  id: number;
  session: string;
  time: string;
  level: RecordLevel;
  /** A log line's message, or a progress event's name. */
  title: string;
  /** A progress event's own message, as the SDK wrote it; none for a log line. */
  text: string | null;
  jobId: string | null;
}

export interface RecordsPage {
  records: RecordSummary[];
  more: boolean;
}

export interface LogRecordDetail {
  kind: "log";
  id: number;
  session: string;
  time: string;
  level: RecordLevel;
  message: string;
  jobId: string | null;
  fields: string;
}

export interface JobEventRecordDetail {
  kind: "job-event";
  id: number;
  session: string;
  time: string;
  seq: number;
  jobId: string;
  event: string;
  level: RecordLevel;
  body: string;
}

export type RecordDetail = LogRecordDetail | JobEventRecordDetail;

/** The values the launch filter offers: every launch that has records. */
export interface RecordSources {
  currentSession: string;
  sessions: string[];
}

function invalid(name: string, expected: string): never {
  throw new Error(`Invalid records query: ${name} must be ${expected}.`);
}

export function isRecordKind(value: unknown): value is RecordKind {
  return RECORD_KINDS.includes(value as RecordKind);
}

/** The query a window sent, checked field by field; throws on anything else. */
export function parseRecordsQuery(value: unknown): RecordsQuery {
  if (typeof value !== "object" || value === null) invalid("the query", "an object");
  const query = value as Record<string, unknown>;
  if (query.session !== null && typeof query.session !== "string") invalid("session", "a string or null");
  if (query.kind !== null && !isRecordKind(query.kind)) invalid("kind", "a record kind or null");
  if (query.level !== null && !RECORD_LEVEL_FILTERS.includes(query.level as RecordLevelFilter)) {
    invalid("level", "a level filter or null");
  }
  if (typeof query.search !== "string") invalid("search", "a string");
  let after: RecordCursor | null = null;
  if (query.after !== null) {
    const cursor = query.after as Record<string, unknown> | undefined;
    if (
      typeof cursor !== "object" ||
      typeof cursor.time !== "string" ||
      !isRecordKind(cursor.kind) ||
      !Number.isInteger(cursor.id)
    ) {
      invalid("after", "a record cursor or null");
    }
    after = { time: cursor.time, kind: cursor.kind, id: cursor.id as number };
  }
  return {
    session: query.session as string | null,
    kind: query.kind as RecordKind | null,
    level: query.level as RecordLevelFilter | null,
    search: query.search,
    after,
  };
}
