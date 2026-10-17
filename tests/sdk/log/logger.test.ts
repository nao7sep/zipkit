/**
 * The logger seam: it stamps the `time`/`message` envelope, gates `debug` behind
 * the instance's `debug` option, and fans out to every sink with per-sink isolation.
 */

import { describe, expect, it } from "vitest";
import { createLogger, type LogSink } from "../../../src/sdk/log/logger.js";
import type { LogEvent } from "../../../src/sdk/types.js";

function collect(): { sink: LogSink; events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { sink: (e) => events.push(e), events };
}

describe("createLogger", () => {
  it("stamps the time and message envelope onto each event", () => {
    const { sink, events } = collect();
    createLogger([sink]).emit({ stage: "scan", level: "info", event: "scan.done", entries: 2, prunedDirs: 0 });

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.time).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
    expect(e.message).toBe("scan complete: 2 entries, 0 pruned dirs");
    expect(e.event).toBe("scan.done"); // the typed fields ride alongside
  });

  it("drops debug unless asked for it, whatever the environment says", () => {
    const { sink, events } = collect();
    process.env.ZIPKIT_DEBUG = "1";
    try {
      createLogger([sink]).emit({ stage: "scan", level: "debug", event: "scan.dir", path: "a" });
    } finally { delete process.env.ZIPKIT_DEBUG; }
    expect(events).toHaveLength(0);

    createLogger([sink], true).emit({ stage: "scan", level: "debug", event: "scan.dir", path: "a" });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("scan.dir");
  });

  it("fans out to every sink and isolates a throwing one", () => {
    const a = collect();
    const thrower: LogSink = () => {
      throw new Error("boom");
    };
    const c = collect();
    const logger = createLogger([a.sink, thrower, c.sink]);

    expect(() =>
      logger.emit({ stage: "scan", level: "info", event: "scan.start", inputs: 1 }),
    ).not.toThrow();
    expect(a.events).toHaveLength(1);
    expect(c.events).toHaveLength(1); // the thrower between them did not starve c
  });

  it("does no work and never throws with no sinks", () => {
    expect(() =>
      createLogger().emit({ stage: "scan", level: "info", event: "scan.start", inputs: 1 }),
    ).not.toThrow();
  });
});
