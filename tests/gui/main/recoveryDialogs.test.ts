import { describe, expect, it } from "vitest";
import { buildRecoveryDialogs } from "../../../src/gui/main/recoveryDialogs.js";

describe("buildRecoveryDialogs", () => {
  it("identifies a recovered queue as pending work, not settings", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: null,
      queueQuarantinedTo: "/tmp/.zipkit/queue-20260817-000000-000-utc.invalid",
    });

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.title).toBe("Saved queue was reset");
    expect(dialogs[0]?.message).toContain("saved pending jobs");
    expect(dialogs[0]?.message).toContain("started with an empty queue");
    expect(dialogs[0]?.message).toContain("Check the ZipKit log");
    expect(dialogs[0]?.message).not.toContain("/tmp/.zipkit");
    expect(dialogs[0]?.message).not.toContain("settings file");
  });

  it("reports settings and queue recoveries separately", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: "/tmp/.zipkit/config.invalid",
      queueQuarantinedTo: "/tmp/.zipkit/queue.invalid",
    });

    expect(dialogs.map((dialog) => dialog.title)).toEqual([
      "Settings were reset",
      "Saved queue was reset",
    ]);
    for (const dialog of dialogs) {
      expect(dialog.message).not.toContain("/tmp/.zipkit");
      expect(dialog.message).toContain("Check the ZipKit log");
    }
  });

  it("builds nothing when both stores loaded clean", () => {
    expect(
      buildRecoveryDialogs({ settingsQuarantinedTo: null, queueQuarantinedTo: null }),
    ).toEqual([]);
  });
});
