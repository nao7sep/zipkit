/**
 * The format version of every store the app writes (store-recovery conventions):
 * one integer per format, in one place, and the error a store written in a newer
 * format raises. The archive's embedded manifest is the SDK's own format and
 * keeps its number beside its writer (`MANIFEST_FORMAT_VERSION`), since the SDK
 * depends on nothing in the app.
 */
export const FORMAT_VERSIONS = {
  /** `config.json`. */
  config: 1,
  /** `queue.json`. */
  queue: 1,
  /** `layout.json`. */
  layout: 1,
  /** `records.sqlite3`, in `PRAGMA user_version`. */
  records: 1,
  /** `backups.sqlite3`, in `PRAGMA user_version`. */
  backups: 1,
} as const;

/** A store a newer build wrote (store-recovery conventions): intact data this
 *  build cannot read, so it is reported and never quarantined, reset or written. */
export class NewerFormatError extends Error {
  readonly file: string;
  readonly found: number;
  readonly supported: number;

  constructor(file: string, found: number, supported: number) {
    super(`${file} has format version ${found}, newer than this build's ${supported}`);
    this.name = "NewerFormatError";
    this.file = file;
    this.found = found;
    this.supported = supported;
  }
}
