import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/sdk/index.ts",
    "cli/main": "src/cli/main.ts",
  },
  format: ["esm"],
  target: "node22",
  experimentalDts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
