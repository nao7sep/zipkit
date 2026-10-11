/** Decide which requested paths are new to one receiver. Identity is the literal
 * host path for now; aliases and overlapping paths remain a separate product
 * policy rather than being guessed from display strings. */
export interface InputAdmission {
  accepted: string[];
  duplicates: number;
}

export function planInputAdmission(existing: Iterable<string>, requested: Iterable<string>): InputAdmission {
  const seen = new Set(existing);
  const accepted: string[] = [];
  let duplicates = 0;
  for (const path of requested) {
    if (!path) continue;
    if (seen.has(path)) {
      duplicates++;
    } else {
      seen.add(path);
      accepted.push(path);
    }
  }
  return { accepted, duplicates };
}
