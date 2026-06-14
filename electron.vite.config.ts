import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The GUI lives under src/gui/{main,preload,renderer,shared} (peers to src/sdk
// and src/cli), so each electron-vite part is pointed at its entry there rather
// than the default src/{main,preload,renderer}. externalizeDepsPlugin keeps the
// SDK's runtime dependencies as externals in the main/preload bundles (the local
// src/sdk source is still bundled in); the renderer bundles React.
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/gui/main/index.ts") } },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/gui/preload/index.ts") } },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/gui/renderer"),
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/gui/renderer/index.html") },
      },
    },
    plugins: [react()],
  },
});
