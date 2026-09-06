import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const config = parse(
  readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8"),
) as {
  files?: string[];
  nsis?: Record<string, unknown>;
};

describe("packaged development metadata", () => {
  it("excludes source maps and TypeScript declarations", () => {
    expect(config.files).toEqual(expect.arrayContaining([
      "!**/*.map",
      "!**/*.d.ts",
      "!**/*.d.mts",
      "!**/*.d.cts",
    ]));
  });
});

describe("Windows installer configuration", () => {
  it("uses the assisted dual-scope NSIS contract", () => {
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
    });
  });
});
