/**
 * Dev only: the real ZipKit with its Records window open over a throwaway data
 * folder, seeded with 10,000 records through the app's own records thread,
 * while three more are logged each second. The folder is a new one in the
 * system's temp folder, printed at start and left there; ZIPKIT_DATA_DIR is
 * ignored, so it never touches real data.
 *
 *   npm run demo:records                      watch it by eye
 *   npm run demo:records -- --seed=500        seed fewer records
 *   ... -- --root=<empty folder>              use that folder instead
 *   ... -- --check                            drive the window, print one
 *                                             `RECORDS-CHECK {json}` line, quit
 *
 * `--check` is what `tests/live/records-window.test.ts` runs. Its page script
 * reads only what Chromium reports (scrollTop, clientHeight, scrollHeight and
 * the rows' rectangles), and waits frame by frame for each state it needs,
 * looking at the state first.
 */

import { app, BrowserWindow } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const check = process.argv.includes("--check");
const seed = Number(process.argv.find((arg) => arg.startsWith("--seed="))?.slice("--seed=".length) ?? 10_000);
const LIVE_MS = 333;

const root = process.argv.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) ??
  mkdtempSync(path.join(tmpdir(), "zipkit-records-demo-"));
process.env.ZIPKIT_DATA_DIR = root;
process.stdout.write(`records demo: ${seed} records in ${root}\n`);

// The app reads its storage root as its modules load, so it is loaded only now.
await import("../../src/gui/main/index.js");
const { log } = await import("../../src/gui/main/runtime.js");
const { openRecordsWindow } = await import("../../src/gui/main/records-window.js");
const { RECORDS_PAGE_SIZE } = await import("../../src/gui/shared/records.js");

const step = (what: string): void => { process.stdout.write(`records demo: ${what}\n`); };
for (let n = 1; n <= seed; n++) log.info(`seed record ${n}`, { n });
// A read answers after every write posted before it.
await log.records({ op: "sessions" });
step("seeded");

// Electron is ready only once this module's top-level awaits have finished,
// so the rest waits for it without holding the module.
void app.whenReady().then(async () => {
  // The Records window takes its title from the language the main window's
  // startup settles, so it opens after the main window.
  await new Promise<void>((resolve) => {
    if (BrowserWindow.getAllWindows().length > 0) resolve();
    else app.once("browser-window-created", () => resolve());
  });
  step("main window open");
  await openRecordsWindow();
  step("records window open");
  let live = 0;
  setInterval(() => log.info(`live record ${++live}`, { n: live }), LIVE_MS);
  if (check) {
    const result = await runCheck();
    process.stdout.write(`RECORDS-CHECK ${JSON.stringify(result)}\n`);
    app.quit();
  }
});

/** Every record's key, newest first, as the database orders them. */
async function databaseOrder(): Promise<string[]> {
  const page = await log.records({
    op: "page",
    query: { session: null, kind: null, level: null, search: "", after: null },
    pageSize: Number.MAX_SAFE_INTEGER,
  });
  return page.records.map((record) => `${record.kind}:${record.id}`);
}

/** Whether `keys` is one unbroken run of `order`. */
function contiguousIn(order: string[], keys: string[]): boolean {
  const start = order.indexOf(keys[0] ?? "");
  return start >= 0 && keys.every((key, index) => order[start + index] === key);
}

interface Row { pos: number; size: number; key: string; title: string; top: number }
interface Snapshot { scrollTop: number; first: Row; size: number; selected: string | null; detail: string | null }

async function runCheck() {
  const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("records.html"))!;
  const page = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script) as Promise<T>;
  await page(PAGE_HELPERS);

  step("check (a)");
  // (a) The first page: 100 records, newest first, in the database's order.
  const first = await page<{ size: number; keys: string[] }>(`(async () => {
    await rc.until(() => rc.size() > 0);
    return { size: rc.size(), keys: rc.rows().map((row) => row.key) };
  })()`);
  const a = { pass: first.size === RECORDS_PAGE_SIZE && contiguousIn(await databaseOrder(), first.keys), size: first.size };

  step("check (c)");
  // (c) At the top, a record logged now appears at the top on its own.
  const top = await page<Row>(`(async () => {
    const before = rc.rows()[0].key;
    await rc.until(() => rc.rows()[0].key !== before && rc.rows()[0].title.startsWith("live record"));
    return rc.rows()[0];
  })()`);
  const c = { pass: top.pos === 1, title: top.title };

  step("check (d)");
  // (d) Scrolled down with a record selected, five stored records move nothing;
  // back at the top they are there, and the selection and its detail stayed.
  const held = await page<{ before: Snapshot; after: Snapshot; back: Snapshot }>(`(async () => {
    const scroll = rc.scroll();
    scroll.scrollTop = 3000;
    await rc.until(() => scroll.scrollTop === 3000);
    await rc.frame();
    const target = rc.visible()[1];
    document.querySelector('[data-record-key="' + target.key + '"]').click();
    await rc.until(() => rc.detail() === target.title);
    await rc.frame();
    const before = rc.snapshot();
    let stored = 0;
    const stop = window.zipkit.onRecordsChanged(() => { stored++; });
    await rc.until(() => stored >= 5);
    stop();
    await rc.frame();
    const after = rc.snapshot();
    scroll.scrollTop = 0;
    await rc.until(() => rc.size() > before.size && rc.rows()[0].pos === 1);
    await rc.frame();
    const back = rc.snapshot();
    // The selected row is out of the rendered range at the top; it is looked
    // for half a screen at a time.
    const selected = () => document.querySelector('[data-record-key="' + before.selected + '"]');
    while (!selected()) { scroll.scrollTop += scroll.clientHeight / 2; await rc.frame(); }
    back.selected = selected().getAttribute("aria-selected") === "true" ? before.selected : null;
    return { before, after, back };
  })()`);
  const same = (x: Snapshot, y: Snapshot) =>
    x.scrollTop === y.scrollTop && x.first.key === y.first.key && x.first.top === y.first.top && x.size === y.size;
  const d = {
    pass: same(held.before, held.after) && held.back.size > held.before.size &&
      held.back.selected === held.before.selected && held.back.detail === held.before.detail,
    ...held,
  };

  step("check (b)");
  // (b) Walking down a screen at a time loads every record once, in order.
  const oldest = (await databaseOrder()).at(-1);
  const walk = await page<{ keys: string[]; conflicts: number; gaps: number; steps: number; longestFrameMs: number }>(`(async () => {
    const scroll = rc.scroll();
    scroll.scrollTop = 1;
    await rc.until(() => scroll.scrollTop >= 1);
    rc.longest = 0;
    const seen = new Map();
    let conflicts = 0;
    let steps = 0;
    for (;;) {
      await rc.frame();
      const rows = rc.rows();
      for (const row of rows) {
        if (seen.has(row.pos) && seen.get(row.pos) !== row.key) conflicts++;
        seen.set(row.pos, row.key);
      }
      const last = rows[rows.length - 1];
      if (last.key === ${JSON.stringify(oldest)} && last.pos === last.size && !rc.loadingMore()) break;
      if (rc.loadingMore()) { await rc.until(() => !rc.loadingMore()); continue; }
      scroll.scrollTop = Math.min(scroll.scrollTop + scroll.clientHeight, scroll.scrollHeight - scroll.clientHeight);
      steps++;
    }
    const positions = [...seen.keys()].sort((x, y) => x - y);
    const gaps = positions.filter((pos, index) => pos !== index + 1).length;
    return { keys: positions.map((pos) => seen.get(pos)), conflicts, gaps, steps, longestFrameMs: rc.longest };
  })()`);
  const order = await databaseOrder();
  const start = order.indexOf(walk.keys[0] ?? "");
  const b = {
    pass: walk.conflicts === 0 && walk.gaps === 0 && walk.keys.length >= seed &&
      start >= 0 && walk.keys.length === order.length - start && contiguousIn(order, walk.keys),
    loaded: walk.keys.length, steps: walk.steps,
  };

  step("check (e)");
  // (e) The window kept answering throughout; its longest frame is reported, not judged.
  const roundTrip = Date.now();
  await page("1");
  const e = { pass: true, longestFrameMsWhileWalking: Math.round(walk.longestFrameMs), roundTripMs: Date.now() - roundTrip };

  return { pass: a.pass && b.pass && c.pass && d.pass, seed, a, b, c, d, e };
}

/** Page-side helpers, kept in the page as `rc`. */
const PAGE_HELPERS = `
window.rc = (() => {
  const rc = {
    longest: 0,
    scroll: () => document.querySelector(".records-list-scroll"),
    frame: () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
    async until(done) { while (!done()) await rc.frame(); },
    rows: () => [...document.querySelectorAll('[role="option"]')].map((option) => ({
      pos: Number(option.getAttribute("aria-posinset")),
      size: Number(option.getAttribute("aria-setsize")),
      key: option.dataset.recordKey,
      title: option.querySelector(".records-row__title").textContent,
      top: option.getBoundingClientRect().top,
      bottom: option.getBoundingClientRect().bottom,
    })).sort((x, y) => x.pos - y.pos),
    size: () => rc.rows()[0]?.size ?? 0,
    visible: () => {
      const box = rc.scroll().getBoundingClientRect();
      return rc.rows().filter((row) => row.top >= box.top && row.bottom <= box.bottom);
    },
    loadingMore: () => rc.scroll().querySelector(":scope > p.records-note") !== null,
    detail: () => document.querySelector(".records-detail__title")?.textContent ?? null,
    snapshot: () => ({
      scrollTop: rc.scroll().scrollTop,
      first: rc.visible()[0],
      size: rc.size(),
      selected: document.querySelector('[aria-selected="true"]')?.dataset.recordKey ?? null,
      detail: rc.detail(),
    }),
  };
  let last = performance.now();
  const tick = (now) => { rc.longest = Math.max(rc.longest, now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return rc;
})();
true;
`;
