import { describe, expect, it } from "vitest";
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { planTests, readsRepository } from "../../scripts/test-plan.mjs";

const repositoryReaders = ["tests/config/electron-vite.test.ts", "tests/sdk/version.test.ts"];

function plan(changed: string[]) {
  return planTests({ changed, full: false, repositoryReaders });
}

describe("the default test plan", () => {
  it("runs nothing when nothing differs from HEAD or only documentation changed", () => {
    expect(plan([])).toEqual({ typecheck: false, vitest: null });
    expect(plan(["README.md", "CHANGELOG.md"])).toEqual({ typecheck: false, vitest: null });
  });

  it("typechecks and runs related and repository-reading tests for a TypeScript change", () => {
    expect(plan(["src/sdk/plan/plan.ts"])).toEqual({
      typecheck: true,
      vitest: ["src/sdk/plan/plan.ts", ...repositoryReaders],
    });
  });

  it("runs the related and repository-reading tests without the type check for a stylesheet change", () => {
    expect(plan(["src/gui/renderer/index.css"])).toEqual({
      typecheck: false,
      vitest: ["src/gui/renderer/index.css", ...repositoryReaders],
    });
  });

  it("typechecks for a JSON change, since modules import JSON", () => {
    expect(plan(["src/strings.json"])).toMatchObject({ typecheck: true, vitest: ["src/strings.json", ...repositoryReaders] });
  });

  it("typechecks when the TypeScript configuration or dependencies change", () => {
    expect(plan(["tsconfig.web.json"]).typecheck).toBe(true);
    expect(plan(["package-lock.json"]).typecheck).toBe(true);
  });
});

describe("the full run plan", () => {
  it("typechecks and runs every test regardless of changes", () => {
    expect(planTests({ changed: [], full: true, repositoryReaders })).toEqual({
      typecheck: true,
      vitest: "all",
    });
  });
});

describe("repository readers", () => {
  it("are the tests that read files through Node", () => {
    expect(readsRepository('import { readFileSync } from "node:fs";')).toBe(true);
    expect(readsRepository('import { rm } from "node:fs/promises";')).toBe(true);
    expect(readsRepository("import { readFileSync } from 'node:fs';")).toBe(true);
    expect(readsRepository('import { existsSync } from "fs";')).toBe(true);
    expect(readsRepository('const fs = await import("node:fs");')).toBe(true);
    expect(readsRepository('import path from "node:path";')).toBe(false);
    expect(readsRepository('import { fsync } from "./fsync";')).toBe(false);
  });
});
