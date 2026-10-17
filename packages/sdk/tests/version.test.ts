/**
 * The SDK's VERSION constant is intentionally a literal (src/sdk/version.ts keeps
 * the build from reaching outside `src/`), so it is a deliberate synced copy of the
 * one source of truth — package.json. This test is the lock-step guard the
 * app-release-conventions require for such a copy: VERSION must equal
 * package.json's version, or a release would self-report a version that has drifted
 * from the real one.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/sdk/version.js";

describe("SDK VERSION", () => {
  it("matches package.json (the single source of truth)", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
