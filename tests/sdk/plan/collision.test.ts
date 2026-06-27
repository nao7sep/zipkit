/**
 * Collision pass (pass 7), tested directly. The pass folds post-fix archive
 * paths case-insensitively and groups them: two distinct paths that fold
 * together are a `collision.case` error, an exact post-fix match is
 * `collision.post-fix`, and a real entry that folds onto a reserved
 * writer-injected name is reported the same way. Every member of a colliding
 * group is flagged; singletons and excluded entries are left alone.
 */

import { describe, expect, it } from "vitest";
import { applyCollision } from "../../../src/sdk/plan/collision.js";
import { workItem } from "../../helpers/synthetic.js";

function rules(item: ReturnType<typeof workItem>): string[] {
  return item.findings.map((f) => f.rule);
}

describe("applyCollision", () => {
  it("flags case-only differences as collision.case on every member", () => {
    const items = [
      workItem({ archivePath: "README.txt" }),
      workItem({ archivePath: "readme.txt" }),
    ];
    applyCollision(items);
    expect(rules(items[0]!)).toEqual(["collision.case"]);
    expect(rules(items[1]!)).toEqual(["collision.case"]);
    expect(items[0]!.findings[0]!.message).toMatch(/differ only by case/);
  });

  it("flags an exact post-fix path match as collision.post-fix", () => {
    const items = [
      workItem({ archivePath: "a.txt", absolutePath: "/src/one/a.txt" }),
      workItem({ archivePath: "a.txt", absolutePath: "/src/two/a.txt" }),
    ];
    applyCollision(items);
    expect(rules(items[0]!)).toEqual(["collision.post-fix"]);
    expect(rules(items[1]!)).toEqual(["collision.post-fix"]);
    expect(items[0]!.findings[0]!.message).toMatch(/resolve to the same archive path/);
  });

  it("leaves a unique name untouched", () => {
    const items = [workItem({ archivePath: "a.txt" }), workItem({ archivePath: "b.txt" })];
    applyCollision(items);
    expect(items[0]!.findings).toEqual([]);
    expect(items[1]!.findings).toEqual([]);
  });

  it("ignores excluded entries when grouping", () => {
    const items = [
      workItem({ archivePath: "a.txt" }),
      workItem({ archivePath: "A.txt", excluded: true, excludeReason: "dropped" }),
    ];
    applyCollision(items);
    // Only one live member folds to the key, so there is no collision.
    expect(items[0]!.findings).toEqual([]);
    expect(items[1]!.findings).toEqual([]);
  });

  it("flags an entry that folds onto a reserved writer name", () => {
    const items = [workItem({ archivePath: "Metadata.json" })];
    applyCollision(items, ["metadata.json"]);
    expect(rules(items[0]!)).toEqual(["collision.post-fix"]);
    expect(items[0]!.findings[0]!.message).toMatch(/reserved metadata file name/);
  });

  it("does not flag a reserved name that no entry collides with", () => {
    const items = [workItem({ archivePath: "data.json" })];
    applyCollision(items, ["metadata.json"]);
    expect(items[0]!.findings).toEqual([]);
  });
});
