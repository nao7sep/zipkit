/** Join preload's frozen submissions before native quit or Mac window close. */
import { ipcMain, type BrowserWindow } from "electron";
import { StepTimeout } from "./step-timeout.js";
import { QUIT_BOUNDS_MS } from "./quit.js";

let nextCapture = 0;
const captures = new WeakMap<BrowserWindow, Promise<void>>();
export function captureJobEdits(win: BrowserWindow | null): Promise<void> {
  if (!win || win.isDestroyed()) return Promise.resolve();
  const active = captures.get(win);
  if (active) return active;
  const contents = win.webContents;
  const id = ++nextCapture;
  const reply = `zipkit:jobEditsCaptured:${id}`;
  const work = new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      ipcMain.removeListener(reply, received);
      contents.removeListener("destroyed", destroyed);
      if (error) reject(error); else resolve();
    };
    const received = (event: Electron.IpcMainEvent, ok: unknown) => {
      if (event.sender !== contents) return;
      finish(ok === true ? undefined : new Error("Pending job edits could not be captured"));
    };
    const destroyed = () => finish(new Error("The job editor closed before its edits were captured"));
    const timer = setTimeout(() => finish(new StepTimeout("Pending job edit capture did not finish")), QUIT_BOUNDS_MS.capture);
    ipcMain.on(reply, received);
    contents.once("destroyed", destroyed);
    try { contents.send("zipkit:captureJobEdits", id); }
    catch (error) { finish(error); }
  });
  captures.set(win, work);
  const retire = () => { if (captures.get(win) === work) captures.delete(win); };
  void work.then(retire, retire);
  return work;
}
export function resumeJobEdits(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.webContents.send("zipkit:resumeJobEdits");
}
