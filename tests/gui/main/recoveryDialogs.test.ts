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
