/** Extraction owns the graph of links it has restored. A later replacement
 * must preserve their containment before it is published. Dependencies limit
 * rechecks to links whose actual traversal consulted the changed pathname. */
import path from "node:path";
import type { BigIntStats } from "node:fs";
import type { Volume } from "../internal/volume.ts";
import { aliasUnprovable, foldedName } from "../internal/name-equivalence.ts";

const key = (file: string): string => file.normalize("NFC").toLowerCase();
const identity = (st: BigIntStats): string => `inode:${st.dev}:${st.ino}`;
const pathname = (file: string): string => `path:${key(file)}`;
const unresolved = (parent: string): string => `unresolved:${parent}`;
const ambiguous = (parent: string): string => `ambiguous:${parent}`;
function outside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}
interface Link { target: string; value: string; dependencies: Set<string> }
interface Proposal { target: string; value: string; oldIdentity?: string; oldNames: Set<string> }
interface Names {
  exact: Set<string>;
  folded: Map<string, Set<string>>;
  identities: Map<string, Set<string>>;
  identityByName: Map<string, string>;
  unindexed: Set<string>;
}
function addName(names: Names, name: string): void {
  names.exact.add(name);
  let group = names.folded.get(key(name));
  if (!group) { group = new Set(); names.folded.set(key(name), group); }
  group.add(name);
  names.unindexed.add(name);
}
function forgetIdentity(names: Names, name: string): void {
  const id = names.identityByName.get(name);
  if (id !== undefined) {
    const group = names.identities.get(id);
    group?.delete(name);
    if (group?.size === 0) names.identities.delete(id);
    names.identityByName.delete(name);
  }
}
function rememberIdentity(names: Names, name: string, id: string): void {
  forgetIdentity(names, name);
  let group = names.identities.get(id);
  if (!group) { group = new Set(); names.identities.set(id, group); }
  group.add(name);
  names.identityByName.set(name, id);
  names.unindexed.delete(name);
}

/** A link value's names in traversal order: Windows resolves either slash, POSIX only `/`. */
export function linkValueComponents(value: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? value.split(/[\\/]/) : value.split("/");
}

export function createLinkTargetGuard(volume: Volume, dest: string) {
  const dependents = new Map<string, Set<Link>>();
  const names = new Map<string, Promise<Names>>();
  let rootPromise: Promise<string> | undefined;
  async function directoryNames(parent: string): Promise<Names> {
    let reading = names.get(parent);
    if (!reading) {
      reading = volume.readdir(parent).then((entries) => {
        const index: Names = { exact: new Set(), folded: new Map(), identities: new Map(), identityByName: new Map(), unindexed: new Set() };
        for (const entry of entries) addName(index, entry.name);
        return index;
      });
      names.set(parent, reading);
    }
    return reading;
  }
  async function existingNames(parent: string, name: string, st: BigIntStats): Promise<Set<string>> {
    const index = await directoryNames(parent);
    if (index.exact.has(name)) {
      rememberIdentity(index, name, identity(st));
      return new Set([name]);
    }
    // Ordinary ASCII alternate casing can be resolved from the spelling index.
    // Unfamiliar aliases require physical lookup; never let a Unicode fold guess
    // which directory entry replacement owns. Multiple hard links are ambiguous.
    const group = index.folded.get(key(name));
    const ascii = !aliasUnprovable(name) && group && [...group].every((entry) => !aliasUnprovable(entry));
    const candidates = ascii ? group : index.unindexed;
    for (const entry of candidates) {
      try {
        rememberIdentity(index, entry, identity(await volume.lstat(path.join(parent, entry))));
      } catch (error) { if (!missing(error)) throw error; }
    }
    const matches = index.identities.get(identity(st)) ?? new Set<string>();
    return new Set(ascii ? [...matches].filter((entry) => group.has(entry)) : matches);
  }
  function remember(link: Link, dependencies: Set<string>): void {
    for (const dependency of link.dependencies) {
      const readers = dependents.get(dependency);
      readers?.delete(link);
      if (readers?.size === 0) dependents.delete(dependency);
    }
    link.dependencies = dependencies;
    for (const dependency of dependencies) {
      let readers = dependents.get(dependency);
      if (!readers) { readers = new Set(); dependents.set(dependency, readers); }
      readers.add(link);
    }
  }

  async function inspect(root: string, link: Link, proposal?: Proposal, foldMissing = false, unknownAliases = true): Promise<Set<string> | null> {
    let current = root;
    let remaining = path.relative(root, path.resolve(path.dirname(link.target), link.value)).split(path.sep).filter(Boolean);
    let links = 0;
    const dependencies = new Set<string>();
    while (remaining.length > 0) {
      const segment = remaining.shift()!;
      if (segment === ".") continue;
      if (segment === "..") { current = path.dirname(current); continue; }
      const next = path.join(current, segment);
      dependencies.add(pathname(next));
      let st;
      try { st = await volume.lstat(next); }
      catch (error) { if (!missing(error)) throw error; }
      if (st) dependencies.add(identity(st));
      else if (remaining.length > 0) {
        // A later alias of an unresolved prefix can activate its suffix. Plain
        // final dangling targets inherit a later restored link's containment.
        dependencies.add(unresolved(current));
        if (aliasUnprovable(segment)) dependencies.add(ambiguous(current));
      }
      let proposed = proposal?.target === next;
      if (proposal && !proposed && path.dirname(proposal.target) === current) {
        if (st && identity(st) === proposal.oldIdentity) {
          const index = await directoryNames(current);
          proposed = !index.exact.has(segment) || proposal.oldNames.has(segment);
        } else if (!st && !proposal.oldIdentity && foldMissing) {
          const name = path.basename(proposal.target);
          proposed = foldedName(name) === foldedName(segment) ||
            (unknownAliases && remaining.length > 0 && (aliasUnprovable(name) || aliasUnprovable(segment)));
        }
      }
      if (!proposed && (!st || !st.isSymbolicLink())) {
        current = st ? await volume.realpath(next) : next;
        continue;
      }
      if (++links > 40) return null;
      const value = proposed ? proposal!.value : await volume.readlink(next);
      if (path.isAbsolute(value)) {
        const base = path.parse(value).root;
        current = base;
        remaining = [...linkValueComponents(value.slice(base.length)), ...remaining];
      } else remaining = [...linkValueComponents(value), ...remaining];
    }
    return outside(root, current) ? null : dependencies;
  }

  return {
    /** Called within extraction's ordered link phase. The returned receipt is
     * registered only after publication (or an unchanged accepted restore). */
    async prepare(target: string, value: string, changing: boolean): Promise<(() => void) | null> {
      const root = await (rootPromise ??= volume.realpath(dest));
      const parent = await volume.realpath(path.dirname(target));
      const location = path.join(parent, path.basename(target));
      let st;
      try { st = await volume.lstat(location); }
      catch (error) { if (!missing(error)) throw error; }
      const oldNames = st ? await existingNames(parent, path.basename(location), st) : new Set<string>();
      const proposal = changing ? { target: location, value, oldIdentity: st && identity(st), oldNames } : undefined;
      const candidate: Link = { target: location, value, dependencies: new Set() };
      const affected = new Set<Link>();
      if (changing) {
        const changed = [pathname(location)];
        if (st) changed.push(identity(st));
        else changed.push(aliasUnprovable(path.basename(location)) ? unresolved(parent) : ambiguous(parent));
        for (const dependency of changed) for (const reader of dependents.get(dependency) ?? []) affected.add(reader);
      }
      const checked = new Map<Link, Set<string>>();
      for (const link of [candidate, ...affected]) {
        const exact = await inspect(root, link, proposal);
        if (!exact) return null;
        // An unknown alias of the candidate itself can recurse to this same
        // value, but cannot reach outside. Conservatism protects prior links;
        // it must not refuse a safe initial dangling Unicode target as a loop.
        const folded = proposal ? await inspect(root, link, proposal, true, link !== candidate) : exact;
        if (!folded) return null;
        checked.set(link, new Set([...exact, ...folded]));
      }
      return () => {
        // Keep ordinary spelling lookup linear across replacements in a folder.
        // An ambiguous hard-link alias cannot identify its old spelling safely.
        if (changing) void names.get(parent)?.then((index) => {
          if (oldNames.size > 1) { names.delete(parent); return; }
          const name = path.basename(location), old = oldNames.values().next().value;
          if (old !== undefined) {
            index.exact.delete(old);
            forgetIdentity(index, old);
            index.unindexed.delete(old);
            const group = index.folded.get(key(old));
            group?.delete(old);
            if (group?.size === 0) index.folded.delete(key(old));
          }
          addName(index, name);
        });
        for (const [link, dependencies] of checked) remember(link, dependencies);
      };
    },
  };
}
export type LinkTargetGuard = ReturnType<typeof createLinkTargetGuard>;
