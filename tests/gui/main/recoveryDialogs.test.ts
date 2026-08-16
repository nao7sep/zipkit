import { describe, expect, it } from "vitest";
import { buildRecoveryDialogs } from "../../../src/gui/main/recoveryDialogs.js";

describe("buildRecoveryDialogs", () => {
  it("identifies a recovered queue as pending work, not settings", () => {
    const dialogs = buildRecoveryDialogs([
      {
        original: "/tmp/.zipkit/queue.json",
        quarantined: "/tmp/.zipkit/queue-20260817-000000-000-utc.invalid",
      },
    ]);

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.title).toBe("Saved queue was reset");
    expect(dialogs[0]?.message).toContain("saved pending jobs");
    expect(dialogs[0]?.message).toContain("started with an empty queue");
    expect(dialogs[0]?.message).not.toContain("settings file");
  });

  it("reports settings and queue recoveries separately", () => {
    const dialogs = buildRecoveryDialogs([
      { original: "/tmp/.zipkit/config.json", quarantined: "/tmp/.zipkit/config.invalid" },
      { original: "/tmp/.zipkit/queue.json", quarantined: "/tmp/.zipkit/queue.invalid" },
    ]);

    expect(dialogs.map((dialog) => dialog.title)).toEqual([
      "Settings were reset",
      "Saved queue was reset",
    ]);
  });
});
