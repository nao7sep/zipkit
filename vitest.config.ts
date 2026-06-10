import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Redirect every test's per-session log off the real `~/.zipkit/logs` (see
    // tests/setup.ts). Every ZipKit instance now opens a session log, so this
    // keeps the suite from writing into the developer's home directory.
    setupFiles: ["./tests/setup.ts"],
  },
});
