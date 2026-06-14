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
  },
});
