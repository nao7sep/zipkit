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
