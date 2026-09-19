import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The same React transform the app build uses, so the renderer-component tests
  // (.tsx) compile with the automatic JSX runtime rather than classic
  // `React.createElement`. Node-side tests have no JSX and are unaffected.
  plugins: [react()],
  test: {
    // Redirect every test's per-session log off the real `~/.zipkit/logs` (see
    // tests/setup.ts). Every ZipKit instance now opens a session log, so this
    // keeps the suite from writing into the developer's home directory.
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      // V8's native coverage — already the installed provider, no instrumentation
      // step. `include` lists every source file (not just the ones a test happens
      // to import) so the report is an instrument for finding logic that no test
      // reaches, not just a score for the code that is reached.
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      // Excluded because there is no decision to cover, only framework wiring —
      // measuring them would bury the real gaps under permanent 0%s:
      exclude: [
        "src/sdk/index.ts", // public barrel: re-exports only
        "src/sdk/types.ts", // type declarations only, no runtime code
        "src/gui/main/index.ts", // Electron main entry: storage-root guard + dynamic import
        "src/gui/main/bootstrap.ts", // window creation + app lifecycle wiring
        "src/gui/preload/index.ts", // contextBridge: one-line ipcRenderer passthroughs
        "src/gui/renderer/src/main.tsx", // React DOM mount
        "**/*.d.ts",
      ],
    },
  },
});
