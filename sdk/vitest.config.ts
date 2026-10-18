import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sdk",
    include: ["tests/**/*.test.ts"],
    // Every test's temp files land in a per-file root that must be empty once
    // its tests finish (see tests/setup.ts).
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // Re-exports and type declarations only: no decision to cover.
      exclude: ["src/index.ts", "src/types.ts", "src/testing.ts"],
    },
  },
});
