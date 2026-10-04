// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordsApp, RecordsWindow } from "../../../../src/gui/renderer/src/records/RecordsWindow";
import type { ZipKitGuiApi } from "../../../../src/gui/shared/api";
import { BODY_PADDING, RECORDS_DETAIL_MIN_WIDTH, RECORDS_LIST_WIDTH, SPLITTER_WIDTH } from "../../../../src/gui/shared/layout";
import type { RecordDetail, RecordsPage, RecordsQuery, RecordSummary } from "../../../../src/gui/shared/records";
import { DEFAULT_SETTINGS } from "../../../../src/gui/shared/spec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "2026-10-02T08:00:00.000Z";

const event: RecordSummary = {
  kind: "job-event", id: 4, session: SESSION, time: "2026-10-02T08:01:00.000Z", level: "error",
  title: "fault", text: "read: /in/a.txt: gone", jobId: "job-1",
};
const line: RecordSummary = {
  kind: "log", id: 9, session: SESSION, time: "2026-10-02T08:00:30.000Z", level: "warn",
  title: "verify failed", text: null, jobId: "job-1",
};
const eventDetail: RecordDetail = {
  kind: "job-event", id: 4, session: SESSION, time: "2026-10-02T08:01:00.250Z", seq: 12, jobId: "job-1",
  event: "fault", level: "error",
  body: JSON.stringify({ event: "fault", code: "read", detail: "/in/a.txt: gone", token: "sk-test" }),
};
const lineDetail: RecordDetail = {
  kind: "log", id: 9, session: "2026-10-01T08:00:00.000Z", time: "2026-10-02T08:00:30.000Z", level: "warn",
  message: "verify failed", jobId: null, fields: JSON.stringify({ archive: "/out/a.zip" }),
};
const newer: RecordSummary = {
  kind: "log", id: 12, session: SESSION, time: "2026-10-02T08:02:00.000Z", level: "info",
  title: "job added", text: null, jobId: null,
};

let root: Root | null = null;
const readRecordsPage = vi.fn<ZipKitGuiApi["readRecordsPage"]>();
const readRecordDetail = vi.fn<ZipKitGuiApi["readRecordDetail"]>();
const readRecordSources = vi.fn<ZipKitGuiApi["readRecordSources"]>();
const reportError = vi.fn<ZipKitGuiApi["reportError"]>();
const saveRecordsListWidth = vi.fn<ZipKitGuiApi["saveRecordsListWidth"]>();
const getRecordsListWidth = vi.fn<ZipKitGuiApi["getRecordsListWidth"]>();
const getSettings = vi.fn<ZipKitGuiApi["getSettings"]>();
let recordsChanged: (() => void) | null = null;
const onRecordsChanged = vi.fn<ZipKitGuiApi["onRecordsChanged"]>((listener) => {
  recordsChanged = listener;
  return () => {
    recordsChanged = null;
  };
});

// jsdom lays nothing out, so the list's scroll box and the shell's width are
// set here. By default the list is scrolled to the top and far from its end.
const box = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 };
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(): void {
    resizeCallbacks.add(this.callback);
  }
  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}
const isScroll = (element: HTMLElement) => element.classList.contains("records-list-scroll");

beforeEach(() => {
  readRecordsPage.mockReset();
  readRecordsPage.mockResolvedValue({ records: [event, line], more: false } satisfies RecordsPage);
  readRecordDetail.mockReset();
  readRecordDetail.mockImplementation(async (kind) => (kind === "log" ? lineDetail : eventDetail));
  readRecordSources.mockReset();
  readRecordSources.mockResolvedValue({ currentSession: SESSION, sessions: [SESSION, "2026-10-01T08:00:00.000Z"] });
  reportError.mockReset();
  saveRecordsListWidth.mockReset();
  saveRecordsListWidth.mockImplementation(async (width) => width);
  getRecordsListWidth.mockReset();
  getRecordsListWidth.mockResolvedValue(450);
  getSettings.mockReset();
  getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, uiFontFamily: "Avenir" });
  onRecordsChanged.mockClear();
  recordsChanged = null;
  Object.assign(box, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 });
  resizeCallbacks.clear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return isScroll(this) ? box.scrollTop : 0; },
      set(this: HTMLElement, value: number) { if (isScroll(this)) box.scrollTop = value; },
    },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.scrollHeight : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.clientHeight : 0; } },
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("records-shell") ? box.shellWidth : 0; },
    },
  });
  Object.defineProperty(window, "zipkit", {
    configurable: true,
    value: {
      readRecordsPage, readRecordDetail, readRecordSources, reportError, saveRecordsListWidth, onRecordsChanged,
      getRecordsListWidth, getSettings,
    } satisfies Partial<ZipKitGuiApi>,
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--font-ui");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["scrollTop", "scrollHeight", "clientHeight", "clientWidth"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

async function mount(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(RecordsWindow, { initialListWidth: RECORDS_LIST_WIDTH.default })));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const titles = () => options().map((option) => option.querySelector(".records-row__title")?.textContent);
const lastQuery = (): RecordsQuery => readRecordsPage.mock.calls.at(-1)![0];
const scrollBox = () => document.querySelector<HTMLElement>(".records-list-scroll")!;
const shell = () => document.querySelector<HTMLElement>(".records-shell")!;
const listColumn = () => shell().style.gridTemplateColumns.split(" ")[0];
const scrollTo = async (top: number, events = 1) => {
  await act(async () => {
    box.scrollTop = top;
    for (let index = 0; index < events; index++) scrollBox().dispatchEvent(new Event("scroll"));
  });
};
const press = async (key: string) => {
  await act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
};
const signal = async () => {
  await act(async () => recordsChanged!());
};
const cursorOf = (record: RecordSummary) => ({ time: record.time, kind: record.kind, id: record.id });
const ALL = { session: null, kind: null, level: null, search: "", after: null };

describe("RecordsWindow", () => {
  it("lists the records newest first, with every filter off and nothing selected yet", async () => {
    await mount();

    expect(titles()).toEqual(["fault", "verify failed"]);
    expect(lastQuery()).toEqual(ALL);
    expect(document.body.textContent).toContain("Select a record to see everything it holds.");
    expect(options()[0]!.tabIndex).toBe(0);
    expect(options()[1]!.tabIndex).toBe(-1);
    expect(document.querySelector('[role="listbox"]')!.getAttribute("tabindex")).toBe("-1");
  });

  it("shows everything a selected progress event holds", async () => {
    await mount();
    await act(async () => options()[0]!.click());

    expect(readRecordDetail).toHaveBeenCalledWith("job-event", 4);
    expect(document.querySelector(".records-detail__title")?.textContent).toBe("fault");
    const blocks = Array.from(document.querySelectorAll(".records-block")).map((block) => [
      block.querySelector("h3")?.textContent,
      block.querySelector("pre")?.textContent,
    ]);
    // The event name is the title already, so Details leaves it out.
    expect(blocks).toEqual([["Details", JSON.stringify({ code: "read", detail: "/in/a.txt: gone", token: "sk-test" }, null, 2)]]);
    const body = document.querySelector(".records-detail__body")!.textContent!;
    expect(body).toContain("job-1");
    expect(body).toContain("Sequence number");
    expect(body).toContain("12");
    expect(body).toContain("250");
    expect(body).toContain("(this launch)");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("shows a log line's message, fields and launch", async () => {
    await mount();
    await act(async () => options()[1]!.click());

    expect(document.querySelector(".records-detail__title")?.textContent).toBe("verify failed");
    expect(document.querySelector(".records-block pre")?.textContent).toBe(JSON.stringify({ archive: "/out/a.zip" }, null, 2));
    const body = document.querySelector(".records-detail__body")!.textContent!;
    expect(body).not.toContain("(this launch)");
    expect(body).not.toContain("Job");
  });

  it("leaves out the Details block of a record with nothing in it, keeping its fields", async () => {
    readRecordDetail.mockImplementation(async () => ({ ...lineDetail, fields: "{}" }));
    await mount();
    await act(async () => options()[1]!.click());

    expect(document.querySelector(".records-detail__title")?.textContent).toBe("verify failed");
    expect(document.querySelector(".records-block")).toBeNull();
    expect(document.querySelector(".records-meta")?.textContent).toContain("Launch");
  });

  it("moves the selection with the arrow keys, stopping at the ends", async () => {
    await mount();
    await act(async () => options()[0]!.focus());
    await press("ArrowDown");
    expect(document.activeElement).toBe(options()[1]);
    expect(readRecordDetail).toHaveBeenLastCalledWith("log", 9);
    await press("ArrowDown");
    expect(document.activeElement).toBe(options()[1]);
    await press("Home");
    expect(document.activeElement).toBe(options()[0]);
  });

  it("reads again with each filter, and searches once typing pauses", async () => {
    await mount();
    const selects = Array.from(document.querySelectorAll("select"));
    expect(Array.from(selects[0]!.options).map((option) => option.textContent)).toEqual([
      "All launches",
      expect.stringContaining("(this launch)"),
      expect.not.stringContaining("(this launch)"),
    ]);
    expect(Array.from(selects[1]!.options).map((option) => option.textContent)).toEqual([
      "All kinds", "Log line", "Progress event",
    ]);

    const choose = async (select: HTMLSelectElement, value: string) => {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await choose(selects[0]!, SESSION);
    await choose(selects[1]!, "job-event");
    await choose(selects[2]!, "error");
    expect(lastQuery()).toEqual({ ...ALL, session: SESSION, kind: "job-event", level: "error" });

    vi.useFakeTimers();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "gone");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(lastQuery().search).toBe("");
    await act(async () => vi.advanceTimersByTime(300));
    expect(lastQuery().search).toBe("gone");
  });

  it("offers Needs attention first among the levels, with the level filter off", async () => {
    await mount();
    const level = document.querySelectorAll("select")[2]!;
    expect(Array.from(level.options).map((option) => option.textContent)).toEqual([
      "All levels", "Needs attention", "Error", "Warning", "Info", "Debug",
    ]);
    expect(level.value).toBe("");
  });

  it("shows a loading note while the first page is read, then the rows", async () => {
    const first = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(first.promise);
    await mount();

    expect(document.body.textContent).toContain("Loading records…");
    expect(document.body.textContent).not.toContain("No records match these filters.");
    expect(options()).toHaveLength(0);

    await act(async () => first.resolve({ records: [event, line], more: false }));
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Loading records…");
  });

  it("keeps an empty list reachable by Tab, saying no records match", async () => {
    readRecordsPage.mockResolvedValue({ records: [], more: false });
    await mount();
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox.tabIndex).toBe(0);
    expect(listbox.textContent).toBe("No records match these filters.");
  });

  it("has no Refresh or Show more button", async () => {
    await mount();
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("reads the next page from the last row once the list is scrolled near its end", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [event], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();
    expect(readRecordsPage).toHaveBeenCalledOnce();

    await scrollTo(700);

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery().after).toEqual(cursorOf(event));
    expect(titles()).toEqual(["fault", "verify failed"]);
  });

  it("reads the next page when ArrowDown is pressed on the last row", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [event, line], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [], more: false });
    await mount();
    await act(async () => options()[1]!.focus());
    await press("ArrowDown");

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery().after).toEqual(cursorOf(line));
    expect(document.activeElement).toBe(options()[1]);
  });

  it("makes one request for two scroll events together", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [event, line], more: true });
    readRecordsPage.mockReturnValueOnce(new Promise<RecordsPage>(() => {}));
    await mount();

    await scrollTo(800, 2);

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).toContain("Loading records…");
  });

  it("reads the next page by itself while a page does not fill the list", async () => {
    box.scrollHeight = 150;
    readRecordsPage.mockResolvedValueOnce({ records: [event], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["fault", "verify failed"]);
  });

  it("keeps a failed page's note at the end, and reads it again when the end is reached again", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [event], more: true });
    readRecordsPage.mockRejectedValueOnce(new Error("busy"));
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    await scrollTo(700);
    expect(document.body.textContent).toContain("The records could not be read.");
    expect(options()).toHaveLength(1);
    expect(readRecordsPage).toHaveBeenCalledTimes(2);

    await scrollTo(750);
    expect(readRecordsPage).toHaveBeenCalledTimes(3);
    expect(lastQuery().after).toEqual(cursorOf(event));
    expect(titles()).toEqual(["fault", "verify failed"]);
    expect(document.body.textContent).not.toContain("The records could not be read.");
  });

  it("re-reads the newest page once for a burst of new records while at the top, keeping the rows shown", async () => {
    await mount();
    vi.useFakeTimers();
    const next = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(next.promise);

    await signal();
    await signal();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery()).toEqual(ALL);
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Loading records…");

    await act(async () => next.resolve({ records: [newer, event, line], more: false }));
    expect(titles()).toEqual(["job added", "fault", "verify failed"]);
  });

  it("leaves the list alone while scrolled down, and shows new records once back at the top", async () => {
    await mount();
    await scrollTo(300);
    vi.useFakeTimers();
    readRecordsPage.mockResolvedValueOnce({ records: [newer, event, line], more: false });

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledOnce();
    expect(options()).toHaveLength(2);

    await scrollTo(0);
    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["job added", "fault", "verify failed"]);
  });

  it("keeps the selected record selected through an update", async () => {
    await mount();
    await act(async () => options()[1]!.click());
    vi.useFakeTimers();
    readRecordsPage.mockResolvedValueOnce({ records: [newer, event, line], more: false });

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    expect(options()).toHaveLength(3);
    expect(options()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(readRecordDetail).toHaveBeenCalledOnce();
  });

  it("stops reading on new-record signals after a failed read, so a logged failure cannot start the next read", async () => {
    await mount();
    vi.useFakeTimers();
    readRecordsPage.mockRejectedValueOnce(new Error("busy"));

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(2);

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
  });

  it("listens for new records again once a read succeeds", async () => {
    readRecordsPage.mockRejectedValueOnce(new Error("busy"));
    await mount();
    expect(document.body.textContent).toContain("The records could not be read.");

    readRecordsPage.mockResolvedValueOnce({ records: [event], more: false });
    await act(async () => {
      const level = document.querySelectorAll("select")[2]!;
      level.value = "error";
      level.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.useFakeTimers();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(3);
  });

  it("stops listening for new records when it closes", async () => {
    await mount();
    expect(recordsChanged).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    expect(recordsChanged).toBeNull();
  });

  it("saves the list width once when a drag ends, clamped to the pane's bounds", async () => {
    await mount();
    const splitter = document.querySelector<HTMLElement>('[role="separator"]')!;
    expect(splitter.getAttribute("aria-label")).toBe("Resize list pane");

    await act(async () => {
      splitter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0 }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 2000 }));
    });
    expect(saveRecordsListWidth).not.toHaveBeenCalled();
    expect(listColumn()).toBe(`${RECORDS_LIST_WIDTH.max}px`);
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup")));

    expect(saveRecordsListWidth).toHaveBeenCalledExactlyOnceWith(RECORDS_LIST_WIDTH.max);
    expect(listColumn()).toBe(`${RECORDS_LIST_WIDTH.max}px`);
  });

  it("saves nothing for a drag that is cancelled", async () => {
    await mount();
    const splitter = document.querySelector<HTMLElement>('[role="separator"]')!;
    await act(async () => {
      splitter.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0 }));
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(saveRecordsListWidth).not.toHaveBeenCalled();
    expect(listColumn()).toBe(`${RECORDS_LIST_WIDTH.default}px`);
  });

  it("narrows the list when the window narrows, saving nothing", async () => {
    await mount();
    expect(listColumn()).toBe(`${RECORDS_LIST_WIDTH.default}px`);

    await act(async () => {
      box.shellWidth = 2 * BODY_PADDING + SPLITTER_WIDTH + RECORDS_DETAIL_MIN_WIDTH + 4 + RECORDS_LIST_WIDTH.min;
      for (const callback of resizeCallbacks) callback();
    });

    expect(listColumn()).toBe(`${RECORDS_LIST_WIDTH.min}px`);
    expect(saveRecordsListWidth).not.toHaveBeenCalled();
  });

  it("says when the records cannot be read, without the raw error", async () => {
    readRecordsPage.mockRejectedValue(new Error("SQLITE_CORRUPT /Users/someone/.zipkit/records.sqlite3"));
    await mount();

    expect(document.body.textContent).toContain("The records could not be read.");
    expect(document.body.textContent).not.toContain("SQLITE_CORRUPT");
    expect(reportError).toHaveBeenCalled();
  });

  it("says when a selected record cannot be read", async () => {
    readRecordDetail.mockResolvedValue(null);
    await mount();
    await act(async () => options()[0]!.click());
    expect(document.body.textContent).toContain("This record could not be read.");
  });
});

describe("RecordsApp", () => {
  it("opens the list at its saved width, in the main window's UI font", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(RecordsApp)));
    expect(listColumn()).toBe("450px");
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Avenir");
  });

  it("opens at the default width when the saved one cannot be read", async () => {
    getRecordsListWidth.mockRejectedValue(new Error("no store"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(RecordsApp)));
    expect(listColumn()).toBe(`${RECORDS_LIST_WIDTH.default}px`);
    expect(reportError).toHaveBeenCalled();
  });
});
