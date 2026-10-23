import { caseFold } from "./name-equivalence.ts";

/** Files (including a reserved manifest) cannot also be implicit folders. */
export function ancestorCollisions<T extends { archivePath: string; type: string }>(entries: readonly T[], reserved: readonly string[] = []): Set<T> {
  const files = new Map<string, T[]>();
  for (const entry of entries) {
    if (entry.type === "dir") continue;
    const key = caseFold(entry.archivePath);
    const group = files.get(key) ?? [];
    group.push(entry);
    files.set(key, group);
  }
  const reservedKeys = new Set(reserved.map(caseFold));
  const conflicts = new Set<T>();
  for (const entry of entries) {
    let parent = entry.archivePath;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const key = caseFold(parent);
      const group = files.get(key);
      if (group || reservedKeys.has(key)) {
        conflicts.add(entry);
        for (const file of group ?? []) conflicts.add(file);
      }
    }
  }
  return conflicts;
}
