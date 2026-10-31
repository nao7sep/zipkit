import { describe, expect, it } from "vitest";
import { buildStartupNotices } from "../../../src/gui/main/startupNotices.js";
import { createTranslator } from "../../../src/gui/shared/i18n/translate.js";

const { t } = createTranslator("en");
const NONE = { queueJobsKept: 0, queueFile: "/tmp/.zipkit/queue.json", recordsOff: null, backupsOff: null };
const said = (notices: ReturnType<typeof buildStartupNotices>) =>
  notices.map((notice) => [t(notice.title), t(notice.message.key, notice.message.values)]);

describe("buildStartupNotices", () => {
  it("says nothing when the launch found nothing to report", () => {
    expect(buildStartupNotices(NONE)).toEqual([]);
  });

  it("says how many saved jobs were kept unread in the queue file", () => {
    const [[title, message]] = said(buildStartupNotices({ ...NONE, queueJobsKept: 2 })) as [[string, string]];
    expect(title).toBe("Some saved jobs were not restored");
    expect(message).toContain("could not read 2 of the jobs saved in /tmp/.zipkit/queue.json");
    expect(message).toContain("stay in the file exactly as they are");
  });

  it("names a records or backups database left off for the session", () => {
    const notices = said(buildStartupNotices({ ...NONE, recordsOff: "/tmp/.zipkit/records.sqlite3", backupsOff: "/tmp/.zipkit/backups.sqlite3" }));
    expect(notices.map(([title]) => title)).toEqual(["Records are off", "Settings backups are off"]);
    expect(notices[0]![1]).toContain("/tmp/.zipkit/records.sqlite3");
    expect(notices[0]![1]).toContain("leaves the database unchanged");
    expect(notices[1]![1]).toContain("/tmp/.zipkit/backups.sqlite3");
  });
});
