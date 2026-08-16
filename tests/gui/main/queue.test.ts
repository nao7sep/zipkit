import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { trashItem: vi.fn() },
}));
vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));
vi.mock("../../../src/gui/main/persist.js", () => ({
  loadQueue: mocks.loadQueue,
  saveQueue: vi.fn(),
  toResumable: vi.fn(() => []),
}));
vi.mock("../../../src/gui/main/runtime.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sendEvent: vi.fn(),
  sendQueue: vi.fn(),
  zip: {},
}));
vi.mock("../../../src/gui/main/queue-engine.js", () => ({
  createQueueEngine: () => ({ restore: mocks.restore }),
}));
vi.mock("../../../src/gui/shared/spec.js", () => ({ buildSpec: vi.fn() }));
vi.mock("../../../src/gui/main/output.js", () => ({ resolveOutputPath: vi.fn() }));
vi.mock("../../../src/gui/main/inputs.js", () => ({ classifyPaths: vi.fn() }));

import { restoreQueue } from "../../../src/gui/main/queue.js";

describe("restoreQueue", () => {
  beforeEach(() => {
    mocks.loadQueue.mockReset();
    mocks.restore.mockReset();
  });

  it("propagates a queue preservation failure instead of inventing an empty queue", async () => {
    const failure = new Error("EPERM: quarantine rename blocked");
    mocks.loadQueue.mockRejectedValue(failure);

    await expect(restoreQueue()).rejects.toBe(failure);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("restores the value returned by the queue loader", async () => {
    const saved = [{ id: "a", inputs: ["/x"], options: {}, intent: "save" }];
    mocks.loadQueue.mockResolvedValue(saved);

    await restoreQueue();

    expect(mocks.restore).toHaveBeenCalledWith(saved);
  });
});
