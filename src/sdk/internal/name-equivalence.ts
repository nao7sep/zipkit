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

/** The spelling two names share when a case-insensitive, normalizing
 *  filesystem may treat them as one; Windows also drops trailing dots and spaces. */
export function foldedName(name: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? name.replace(/[. ]+$/, "") : name).normalize("NFC").toLowerCase();
}
