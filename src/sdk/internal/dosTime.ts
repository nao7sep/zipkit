/**
 * The DOS modification-time field used by ZIP can represent only 1980-01-01
 * through 2107-12-31. These are the inclusive lower and exclusive upper bounds
 * of that range, in nanoseconds since the Unix epoch (UTC). The plan's
 * timestamp pass uses them to flag out-of-range times; the writer uses them to
 * clamp, so a single definition keeps the two in agreement. `Date.UTC` is a
 * pure, clock-free computation evaluated once at load.
 */

export const DOS_EPOCH_NS = BigInt(Date.UTC(1980, 0, 1)) * 1_000_000n;
export const DOS_LIMIT_NS = BigInt(Date.UTC(2108, 0, 1)) * 1_000_000n;
