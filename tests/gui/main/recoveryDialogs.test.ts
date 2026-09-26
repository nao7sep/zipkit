import { describe, expect, it } from "vitest";
import { buildRecoveryDialogs } from "../../../src/gui/main/recoveryDialogs.js";
import { createTranslator } from "../../../src/gui/shared/i18n/translate.js";

const { t } = createTranslator("en");

describe("buildRecoveryDialogs", () => {
  it("identifies a recovered queue as pending work, not settings", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: null,
      queueQuarantinedTo: "/tmp/.zipkit/queue-20260817-000000-000-utc.invalid",
    });

    expect(dialogs).toHaveLength(1);
    expect(t(dialogs[0]!.title)).toBe("Saved queue was reset");
    const message = t(dialogs[0]!.message);
    expect(message).toContain("saved pending jobs");
    expect(message).toContain("started with an empty queue");
    expect(message).toContain("Check the ZipKit log");
    expect(message).not.toContain("/tmp/.zipkit");
    expect(message).not.toContain("settings file");
  });

  it("reports settings and queue recoveries separately", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: "/tmp/.zipkit/config.invalid",
      queueQuarantinedTo: "/tmp/.zipkit/queue.invalid",
    });

    expect(dialogs.map((dialog) => t(dialog.title))).toEqual([
      "Settings were reset",
      "Saved queue was reset",
    ]);
    for (const dialog of dialogs) {
      expect(t(dialog.message)).not.toContain("/tmp/.zipkit");
      expect(t(dialog.message)).toContain("Check the ZipKit log");
    }
  });

  it("builds nothing when both stores loaded clean", () => {
    expect(
      buildRecoveryDialogs({ settingsQuarantinedTo: null, queueQuarantinedTo: null }),
    ).toEqual([]);
  });
});
