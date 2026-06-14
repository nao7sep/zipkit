/**
 * Timezone resolution and wall-clock rendering, used only by the writer's DOS
 * field. The ZIP DOS date/time field stores *local* wall-clock time with no
 * timezone attached (every reader interprets it in the viewer's zone), so to
 * fill it faithfully we must render an absolute instant into a chosen IANA zone.
 *
 * The absolute extras the writer also emits — the Info-ZIP extended timestamp
 * (0x5455) and the NTFS extra (0x000a) — are UTC by specification and need none
 * of this; only the DOS field is timezone-sensitive.
 *
 * Zones are named with IANA Time Zone Database identifiers (e.g. `Asia/Tokyo`,
 * `UTC`). `Intl` is clock-free here: it converts a supplied instant, it does not
 * read the current time. Formatters are cached per zone since one is reused for
 * every entry in a run.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23", // 00–23, never a 24:00 or 12-hour rendering
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The host's IANA timezone — the default DOS-field zone when none is given. */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whether a string is an IANA zone the runtime accepts (rejects offsets too). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number; // 0–59
  second: number; // 0–59
}

/**
 * The inverse of {@link wallClockInZone}: the absolute instant (epoch ms) whose
 * local rendering in `timeZone` equals the given wall clock. Used on extraction
 * to turn a zone-less DOS field back into an instant for archives that carry no
 * UTC time extra. A single offset correction is exact except within a DST
 * transition's ambiguous or skipped hour, where it lands on one valid reading —
 * acceptable for the DOS field's 2-second, zone-less precision.
 */
export function instantFromWallClockInZone(w: WallClock, timeZone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const rendered = wallClockInZone(guess, timeZone);
  const renderedAsUtc = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    rendered.second,
  );
  return guess - (renderedAsUtc - guess);
}

/** The local wall-clock components of an absolute instant in the given zone. */
export function wallClockInZone(epochMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
