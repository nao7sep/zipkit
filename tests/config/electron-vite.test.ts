import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

describe("Electron development endpoint", () => {
  it("owns a stable strict loopback port", () => {
    expect(config.renderer?.server).toMatchObject({ host: "127.0.0.1", port: 29819, strictPort: true });
  });
});

describe("Build-time defines", () => {
  // src/gui/shared/identity.ts evaluates __APP_VERSION__ at module load and any
  // part may import it (the renderer does, for About). vitest defines it
  // globally, so only the build config itself can prove each part has it.
  it.each(["main", "preload", "renderer"] as const)("gives the %s bundle __APP_VERSION__", (part) => {
    expect(config[part]?.define).toHaveProperty("__APP_VERSION__");
  });
});
