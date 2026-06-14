import { defineConfig } from "tsup";

// Builds the CLI bundle (the `zipkit` bin) from src/cli/main.ts, with the SDK
// engine bundled in from src/sdk. The GUI is built separately by electron-vite;
// the SDK is consumed by both the CLI and the GUI as source, never as a published
// package, so no standalone library entry or type declarations are emitted here.
export default defineConfig({
  entry: { "cli/main": "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  tsconfig: "tsconfig.node.json",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
