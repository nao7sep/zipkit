import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

describe("Electron development endpoint", () => {
  const server = config.renderer?.server;

  it("is a strict loopback port", () => {
    expect(server).toMatchObject({ host: "127.0.0.1", strictPort: true });
    expect(server?.port).toBeTypeOf("number");
  });
});

describe("Build-time defines", () => {
  // The app's identity module evaluates __APP_VERSION__ at module load and any
  // part may import it (the renderer does, for About). vitest defines it
  // globally, so only the build config itself can prove each part has it.
  it.each(["main", "preload", "renderer"] as const)("gives the %s bundle __APP_VERSION__", (part) => {
    expect(config[part]?.define).toHaveProperty("__APP_VERSION__");
  });
});
