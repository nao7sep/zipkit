/**
 * What a name's spelling can prove about aliasing when no filesystem identity
 * exists for it (the name does not exist yet). Existing names compare by
 * identity instead. The platform is an input so each host's rules are testable
 * on any host; callers pass nothing and get the running one.
 */

/** Whether spelling alone cannot rule out that `name` aliases a differently
 *  spelled name: Unicode equivalence is filesystem-owned everywhere, and on
 *  Windows a `~1` short name or trailing dots and spaces can resolve elsewhere. */
export function aliasUnprovable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return /[^\x00-\x7f]/.test(name) || (platform === "win32" && (/~\d/.test(name) || /[. ]$/.test(name)));
}

/**
 * The key two names share when a case-insensitive file system treats them as
 * one: composed (NFC), then each character uppercased by its single-character
 * mapping, as NTFS's upcase table and APFS's case-insensitive comparison do.
 * So `ς` and `σ` (both `Σ`) are one name, while `ß`, whose full uppercase is
 * two characters, stays apart from `ss`.
 */
export function caseFold(name: string): string {
  let folded = "";
  for (const ch of name.normalize("NFC")) {
    const upper = ch.toUpperCase();
    folded += [...upper].length === 1 ? upper : ch;
  }
  return folded;
}

/** The spelling two names share when a case-insensitive, normalizing
 *  filesystem may treat them as one ({@link caseFold}); Windows also drops
 *  trailing dots and spaces. */
export function foldedName(name: string, platform: NodeJS.Platform = process.platform): string {
  return caseFold(platform === "win32" ? name.replace(/[. ]+$/, "") : name);
}
