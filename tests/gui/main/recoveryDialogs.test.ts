import { describe, expect, it } from "vitest";
import { buildRecoveryDialogs } from "../../../src/gui/main/recoveryDialogs.js";
import { createTranslator } from "../../../src/gui/shared/i18n/translate.js";

const { t } = createTranslator("en");

describe("buildRecoveryDialogs", () => {
  it("identifies a recovered queue as pending work, not settings", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: null,
      queueQuarantinedTo: "/tmp/.zipkit/queue-20260817-000000-utc.invalid",
      queueJobsRestored: 0,
    });

    expect(dialogs).toHaveLength(1);
    expect(t(dialogs[0]!.title)).toBe("Saved queue was reset");
    const message = t(dialogs[0]!.message.key, dialogs[0]!.message.values);
    expect(message).toContain("saved pending jobs");
    expect(message).toContain("preserved as /tmp/.zipkit/queue-20260817-000000-utc.invalid");
    expect(message).toContain("started with an empty queue");
    expect(message).not.toContain("settings file");
  });

  it("reports settings and queue recoveries separately", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: "/tmp/.zipkit/config.invalid",
      queueQuarantinedTo: "/tmp/.zipkit/queue.invalid",
      queueJobsRestored: 0,
    });

    expect(dialogs.map((dialog) => t(dialog.title))).toEqual([
      "Settings were reset",
      "Saved queue was reset",
    ]);
    const [settings, queue] = dialogs.map((dialog) => t(dialog.message.key, dialog.message.values));
    expect(settings).toContain("preserved as /tmp/.zipkit/config.invalid");
    expect(settings).toContain("using default settings");
    expect(queue).toContain("preserved as /tmp/.zipkit/queue.invalid");
  });

  it("builds nothing when both stores loaded clean", () => {
    expect(
      buildRecoveryDialogs({ settingsQuarantinedTo: null, queueQuarantinedTo: null, queueJobsRestored: 3 }),
    ).toEqual([]);
  });

  it("says the readable jobs were restored when only some saved jobs could not be read", () => {
    const dialogs = buildRecoveryDialogs({
      settingsQuarantinedTo: null,
      queueQuarantinedTo: "/tmp/.zipkit/queue-20260817-000000-utc.invalid",
      queueJobsRestored: 2,
    });

    expect(dialogs).toHaveLength(1);
    expect(t(dialogs[0]!.title)).toBe("Some saved jobs were not restored");
    const message = t(dialogs[0]!.message.key, dialogs[0]!.message.values);
    expect(message).toContain("some of its saved pending jobs");
    expect(message).toContain("with every job in it, was preserved as /tmp/.zipkit/queue-20260817-000000-utc.invalid");
    expect(message).toContain("restored the jobs it could read");
    expect(message).not.toContain("empty queue");
  });
});
