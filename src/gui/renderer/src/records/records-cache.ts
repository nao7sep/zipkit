/** Cursor geometry survives traversal; at most five pages retain row bodies. */
import { RECORDS_PAGE_SIZE, type RecordCursor, type RecordsPage, type RecordSummary } from "../../../shared/records";
import { cursorAfter, mergeNewestPage, recordKey } from "./record-format";

export interface RecordSegment {
  after: RecordCursor | null;
  length: number;
  tailCursor: RecordCursor | null;
  start: number;
}

export class RecordsCache {
  segments: RecordSegment[] = [];
  readonly pages = new Map<number, RecordSummary[]>();
  more = false;

  get length(): number {
    const tail = this.segments.at(-1);
    return tail ? tail.start + tail.length : 0;
  }

  segmentAt(index: number): number {
    let low = 0, high = this.segments.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const segment = this.segments[mid]!;
      if (index < segment.start) high = mid - 1;
      else if (index >= segment.start + segment.length) low = mid + 1;
      else return mid;
    }
    return -1;
  }

  row(index: number): RecordSummary | undefined {
    const segment = this.segmentAt(index);
    return this.pages.get(segment)?.[index - this.segments[segment]!.start];
  }

  append(page: RecordsPage): void {
    const after = this.segments.at(-1)?.tailCursor ?? null;
    // A server page is bounded; merged newest pages are split at the same seam.
    for (let at = 0; at < page.records.length; at += RECORDS_PAGE_SIZE) {
      const rows = page.records.slice(at, at + RECORDS_PAGE_SIZE);
      const previous = this.segments.at(-1);
      this.pages.set(this.segments.length, rows);
      this.segments.push({ after: at === 0 ? after : previous!.tailCursor,
        length: rows.length, tailCursor: cursorAfter(rows), start: this.length });
    }
    this.more = page.more;
  }

  newest(page: RecordsPage): void {
    const first = this.pages.get(0) ?? [];
    const merged = mergeNewestPage(first, this.segments.length > 1 || this.more, page);
    const retained = first.length > 0 && merged.records.some((row) => recordKey(row) === recordKey(first[0]!));
    const oldSegments = retained ? this.segments.slice(1) : [];
    const oldPages = retained ? new Map(this.pages) : new Map<number, RecordSummary[]>();
    const oldMore = this.more;
    this.segments = [];
    this.pages.clear();
    this.append({ records: merged.records, more: oldSegments.length ? oldMore : merged.more });
    const shift = this.segments.length - 1;
    for (const segment of oldSegments) {
      this.segments.push({ ...segment, start: this.length });
    }
    for (const [index, rows] of oldPages) if (index > 0) this.pages.set(index + shift, rows);
    this.retain(0);
  }

  /** Keep the first page and four cached segments nearest the viewport. */
  retain(center: number): void {
    const nearest = [...this.pages.keys()].filter((index) => index !== 0)
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center)).slice(0, 4);
    const keep = new Set([0, ...nearest]);
    for (const index of this.pages.keys()) if (!keep.has(index)) this.pages.delete(index);
  }
}
