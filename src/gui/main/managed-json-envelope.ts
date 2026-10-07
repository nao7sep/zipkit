/** Pure envelope validation shared by managed reads and both write paths. */

export class InvalidManagedJsonError extends Error {
  constructor(store: string, detail: string) {
    super(`${store} is invalid: ${detail}`);
    this.name = "InvalidManagedJsonError";
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse a managed JSON document's root object. */
export function parseJsonObject(text: string, store: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidManagedJsonError(store, "not valid JSON");
  }
  if (!isPlainObject(value)) throw new InvalidManagedJsonError(store, "root must be an object");
  return value;
}

/** The format version a document's `formatVersion` records; a document without one is unreadable. */
export function storedFormatVersion(root: Record<string, unknown>, store: string): number {
  const value = root.formatVersion;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidManagedJsonError(store, "formatVersion must be a positive integer");
  }
  return value;
}
