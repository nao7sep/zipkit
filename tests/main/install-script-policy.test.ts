import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LockedPackage = { hasInstallScript?: boolean; resolved?: string; version?: string; name?: string };
type Lockfile = { packages: Record<string, LockedPackage> };
type Policy = Record<string, unknown>;

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lockfile: Lockfile = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));

// npm matches registry approvals against the resolved tarball's identity, not the installed
// folder or package manifest. Keep this guard limited to this app's registry-only lockfile.
function policyProblems(policy: Policy, lock: Lockfile): string[] {
  const identities = new Set<string>();
  const problems: string[] = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!entry.hasInstallScript) continue;
    const match = entry.resolved?.match(/^https?:\/\/[^/]+\/((?:@[^/]+\/)?([^/]+))\/-\/([^/]+)\.tgz$/);
    const name = match?.[1];
    const project = match?.[2];
    const tarball = match?.[3];
    const version = project && tarball?.startsWith(`${project}-`) ? tarball.slice(project.length + 1) : undefined;
    if (!name || !version || version !== entry.version) {
      problems.push(`${location}: install script lacks a matching resolved registry identity`);
      continue;
    }
    const identity = `${name}@${version}`;
    identities.add(identity);
    if (typeof policy[identity] !== "boolean") problems.push(`${identity}: missing explicit script decision`);
  }
  for (const identity of Object.keys(policy)) {
    if (!identities.has(identity)) problems.push(`${identity}: policy entry is not an exact script-bearing lockfile identity`);
  }
  return problems;
}

function fixture(): { policy: Policy; lock: Lockfile } {
  return {
    policy: { "@scope/tool@1.2.3": true, "helper@4.5.6": false },
    lock: { packages: {
      "node_modules/alias": { hasInstallScript: true, name: "untrusted-name", version: "1.2.3", resolved: "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz" },
      "node_modules/parent/node_modules/helper": { hasInstallScript: true, version: "4.5.6", resolved: "https://registry.npmjs.org/helper/-/helper-4.5.6.tgz" },
      "node_modules/no-script": { version: "7.8.9" },
    } },
  };
}

describe("npm install-script approvals", () => {
  it("reviews every script-bearing locked identity with an exact boolean decision", () => {
    expect(policyProblems(manifest.allowScripts, lockfile)).toEqual([]);
  });

  it("uses resolved identities for scoped, aliased and nested packages, preserving denies", () => {
    const { policy, lock } = fixture();
    expect(policyProblems(policy, lock)).toEqual([]);
  });

  it.each(["https://example.com/download.tgz", "https://registry.npmjs.org/@scope/tool/-/tool-9.9.9.tgz"])("rejects unrecognizable or inconsistent resolved identities (%s)", (resolved) => {
    const { policy, lock } = fixture();
    lock.packages["node_modules/alias"] = { hasInstallScript: true, version: "1.2.3", resolved };
    expect(policyProblems(policy, lock)).not.toEqual([]);
  });

  it.each(["node_modules/alias", "node_modules/parent/node_modules/helper"])("rejects missing resolved metadata for either approval decision (%s)", (location) => {
    const { policy, lock } = fixture();
    delete lock.packages[location]!.resolved;
    expect(policyProblems(policy, lock)).not.toEqual([]);
  });

  it("rejects a resolved package name different from the reviewed identity", () => {
    const { policy, lock } = fixture();
    lock.packages["node_modules/alias"]!.resolved = "https://registry.npmjs.org/@other/tool/-/tool-1.2.3.tgz";
    expect(policyProblems(policy, lock)).toContain("@other/tool@1.2.3: missing explicit script decision");
  });

  it.each(["@scope/tool", "@scope/tool@^1.2.3", "@scope/tool@1.2.3 || 1.2.4"])("rejects broader approval %s", (key) => {
    const { policy, lock } = fixture();
    delete policy["@scope/tool@1.2.3"];
    policy[key] = true;
    expect(policyProblems(policy, lock)).not.toEqual([]);
  });

  it("rejects unreviewed scripts, stale approvals and non-boolean decisions", () => {
    const { policy, lock } = fixture();
    delete policy["helper@4.5.6"];
    policy["removed@1.0.0"] = false;
    policy["@scope/tool@1.2.3"] = "true";
    expect(policyProblems(policy, lock)).toEqual([
      "@scope/tool@1.2.3: missing explicit script decision",
      "helper@4.5.6: missing explicit script decision",
      "removed@1.0.0: policy entry is not an exact script-bearing lockfile identity",
    ]);
  });
});
