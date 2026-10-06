import { describe, expect, it } from "vitest";
import { buildRecoveryDialogs, startupHaltMessage } from "../../../src/gui/main/recoveryDialogs.js";
import { NewerFormatError } from "../../../src/gui/main/formatVersions.js";
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
    const message = t(dialogs[0]!.message.key, dialogs[0]!.message.values);
    expect(message).toContain("saved pending jobs");
    expect(message).toContain("preserved as /tmp/.zipkit/queue-20260817-000000-000-utc.invalid");
    expect(message).toContain("started with an empty queue");
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
    const [settings, queue] = dialogs.map((dialog) => t(dialog.message.key, dialog.message.values));
    expect(settings).toContain("preserved as /tmp/.zipkit/config.invalid");
    expect(settings).toContain("using default settings");
    expect(queue).toContain("preserved as /tmp/.zipkit/queue.invalid");
  });

  it("builds nothing when both stores loaded clean", () => {
    expect(
      buildRecoveryDialogs({ settingsQuarantinedTo: null, queueQuarantinedTo: null }),
    ).toEqual([]);
  });
});

describe("startupHaltMessage", () => {
  it("names a store a newer build wrote by its path and says it was left unchanged", () => {
    const halt = startupHaltMessage(new NewerFormatError("/Users/me/.zipkit/queue.json", 2, 1));
    expect(halt).toEqual({ key: "startup.newerStore", values: { file: "/Users/me/.zipkit/queue.json" } });
    const text = t(halt.key, halt.values);
    expect(text).toContain("/Users/me/.zipkit/queue.json");
    expect(text).toContain("newer version of ZipKit");
    expect(text).toContain("left unchanged");
  });

  it("keeps the general guidance, without the diagnostic, for any other failure", () => {
    expect(startupHaltMessage(new Error("EACCES: /private/tmp/secret"))).toEqual({ key: "startup.halted" });
  });
});
