import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

import { readFileSync } from "node:fs";

// __APP_VERSION__ is injected from package.json by electron.vite.config.ts for the
// build; mirrored here so the tests run against the same value.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  // The same React transform the app build uses, so the renderer-component tests
  // (.tsx) compile with the automatic JSX runtime rather than classic
  // `React.createElement`. Node-side tests have no JSX and are unaffected.
  plugins: [react()],
  test: {
    // Tests carry no timeouts (tests-folder conventions): a test waits for the
    // event it needs, and the runner reports how long each one took.
    testTimeout: 0,
    hookTimeout: 0,
    // Two projects, so `vitest` at the repository root runs both suites and a
    // path under either tests folder resolves: the app's, configured here, and
    // the SDK's, which keeps its own configuration in sdk/ as it would in a
    // repository of its own.
    projects: [
      {
        extends: true,
        test: {
          name: "app",
          include: ["tests/**/*.test.{ts,tsx}"],
          // The full gate's tests need the built app (vitest.live.config.ts).
          exclude: [...configDefaults.exclude, "tests/live/**"],
          // Redirect every test's storage root and log directory off the real
          // `~/.zipkit` (see tests/setup.ts), so the suite never writes into the
          // developer's home directory.
          // Every spec that mounts the interface also checks that no catalogue key
          // reaches the screen (localization-conventions, Gates).
          // Every jsdom file sets React and Testing Library up before its first test.
          setupFiles: ["./tests/setup.ts", "./tests/setup/rendered-keys.ts", "./tests/setup/jsdom-warmup.ts"],
          // Electron's npm package downloads its ~100 MB binary the first time
          // anything resolves it while the binary is missing (a fresh `npm ci`). No
          // unit test runs Electron, so a placeholder path keeps the suite offline.
          env: { ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent/zipkit-unit-tests" },
        },
      },
      "./sdk",
    ],
    coverage: {
      // V8's native coverage — already the installed provider, no instrumentation
      // step. `include` lists every source file (not just the ones a test happens
      // to import) so the report is an instrument for finding logic that no test
      // reaches, not just a score for the code that is reached.
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}", "sdk/src/**/*.ts"],
      // Excluded because there is no decision to cover, only framework wiring —
      // measuring them would bury the real gaps under permanent 0%s:
      exclude: [
        "src/gui/main/index.ts", // Electron main entry: storage-root guard + dynamic import
        "src/gui/main/bootstrap.ts", // window creation + app lifecycle wiring
        "src/gui/preload/index.ts", // contextBridge: one-line ipcRenderer passthroughs
        "src/gui/renderer/src/main.tsx", // React DOM mount
        "src/gui/renderer/src/records.tsx", // the Records window's React DOM mount
        "sdk/src/index.ts", // the SDK's entries: re-exports only
        "sdk/src/types.ts", // type declarations only
        "sdk/src/testing.ts",
        "**/*.d.ts",
      ],
    },
  },
});
