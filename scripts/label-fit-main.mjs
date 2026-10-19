// Electron entry for scripts/label-fit.mjs: starts the built app in this
// process with every window hidden, sizes each window to its minimum, and
// writes what each surface's text does not fit to LABEL_FIT_RESULT.

import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
app.setPath("userData", process.env.LABEL_FIT_USER_DATA);
for (const method of ["show", "showInactive", "focus", "moveTop"]) BrowserWindow.prototype[method] = function hidden() {};
app.on("browser-window-created", (_event, window) => window.webContents.setBackgroundThrottling(false));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (const start = Date.now(); !(await check()); await sleep(100)) {
    if (Date.now() - start > 30_000) throw new Error(`Timed out waiting for ${what}`);
  }
}

// Runs in the page. Reports elements with their own text that are clipped or
// truncated, buttons whose label wraps, and text that crosses the edge of its
// nearest clipping or scrolling ancestor. Screen-reader-only text is skipped.
function unfit() {
  const found = [];
  const clipping = (style) => /hidden|clip|auto|scroll/.test(style.overflowX);
  for (const el of document.querySelectorAll("body *")) {
    if (![...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
    if (el.getClientRects().length === 0) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (style.display !== "inline" && !/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      found.push({ issue: `${style.textOverflow === "ellipsis" ? "truncated" : "clipped"} by ${el.scrollWidth - el.clientWidth}px`, text });
    }
    const button = el.closest("button");
    if (button && button.scrollHeight > button.clientHeight + 1) found.push({ issue: `button wraps at ${Math.round(button.getBoundingClientRect().width)}px`, text });
    let owner = el.parentElement;
    while (owner && owner !== document.body && !clipping(getComputedStyle(owner))) owner = owner.parentElement;
    if (owner && owner !== document.body) {
      const bounds = owner.getBoundingClientRect();
      const by = Math.round(Math.max(rect.right - bounds.right, bounds.left - rect.left));
      if (by > 1) found.push({ issue: `outside ${owner.tagName.toLowerCase()}${owner.className ? `.${owner.className}` : ""} by ${by}px`, text });
    }
  }
  return found;
}

async function page(name) {
  let window;
  await until(() => (window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith(`/${name}`))), name);
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  const [width, height] = window.getMinimumSize();
  window.setSize(width, height);
  const run = (fn) => window.webContents.executeJavaScript(`(${fn})()`, true);
  const settle = async () => { await run(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await sleep(300); };
  const waitFor = (selector) => until(() => window.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
  await settle();
  return { run, settle, waitFor, exec: (source) => window.webContents.executeJavaScript(source, true) };
}

// Not awaited at top level: Electron holds its ready event until the entry
// module finishes evaluating, so awaiting the app's startup here would deadlock.
void measure();

async function measure() {
  const findings = [];
  let error;
  try {
    await import(pathToFileURL(join(repo, "out/main/index.js")).href);
    await app.whenReady();
    const main = await page("index.html");
    const check = async (surface, target) => {
      for (const finding of await target.run(unfit)) findings.push({ surface, ...finding });
    };
    await main.waitFor('[data-job-id="fit"]');
    await main.exec(`document.querySelector('[data-job-id="fit"]').click()`);
    await main.settle();
    await check("main", main);
    // Radix opens on pointerdown; Settings is the menu's first command.
    await main.exec(`document.querySelector("header button").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`);
    await main.waitFor('[role="menuitem"]');
    await main.exec(`document.querySelector('[role="menuitem"]').click()`);
    await main.waitFor('[role="dialog"]');
    await main.settle();
    // Each Settings tab in turn, since a hidden panel measures as nothing.
    const tabs = await main.exec(`document.querySelectorAll('[role="dialog"] [role="tab"]').length`);
    for (let i = 0; i < tabs; i++) {
      await main.exec(`document.querySelectorAll('[role="dialog"] [role="tab"]')[${i}].click()`);
      await main.settle();
      await check(`settings tab ${i + 1}`, main);
    }
    await main.exec("window.zipkit.openRecordsWindow()");
    const records = await page("records.html");
    await records.waitFor('[role="listbox"]');
    await records.settle();
    await check("records", records);
  } catch (failure) {
    error = failure instanceof Error ? failure.stack ?? failure.message : String(failure);
  }
  await writeFile(process.env.LABEL_FIT_RESULT, JSON.stringify({ findings, error }));
  app.exit(0);
}
