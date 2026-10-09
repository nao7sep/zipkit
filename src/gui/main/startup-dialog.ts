import { BrowserWindow } from "electron";
import type { MessageKey } from "../shared/i18n/catalogues.js";
import type { MessageValues } from "../shared/i18n/translate.js";
import { mainTranslator, settledTranslator } from "./i18n.js";
import { windowBackground } from "./theme.js";

export interface AppMessageDialogOptions {
  owner?: BrowserWindow;
  title: string;
  message: string;
  /** The one button: OK acknowledges a report, Quit ends a failed launch. */
  button: "ok" | "quit";
}

/** Everything the document shows, already in the interface language. */
export interface AppMessageDialogText {
  /** The interface language's tag, for `<html lang>`. */
  lang: string;
  title: string;
  message: string;
  buttonLabel: string;
  /** The accessible name of the scrollable message region. */
  regionLabel: string;
  choices?: { labels: string[]; defaultId: number };
}

const MESSAGE_DIALOG_MIN_HEIGHT = 220;
const MESSAGE_DIALOG_MAX_HEIGHT = 640;

export function boundedMessageDialogHeight(contentHeight: number, frameHeight: number): number {
  return Math.min(
    MESSAGE_DIALOG_MAX_HEIGHT,
    Math.max(MESSAGE_DIALOG_MIN_HEIGHT, Math.ceil(contentHeight + frameHeight)),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Complete app-authored document used by both fatal and recovery messages. */
export function buildAppMessageDialogDocument({
  lang,
  title,
  message,
  buttonLabel,
  regionLabel,
  choices,
}: AppMessageDialogText): string {
  const buttons = choices
    ? choices.labels.map((label, index) => `<button ${index === choices.defaultId ? "autofocus " : ""}onclick="location.href='zipkit-dialog-choice://${index}'">${escapeHtml(label)}</button>`).join("")
    : `<button autofocus onclick="window.close()">${escapeHtml(buttonLabel)}</button>`;
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box;scrollbar-width:auto;scrollbar-color:#7d826c transparent}*::-webkit-scrollbar{width:16px;height:16px}*::-webkit-scrollbar-thumb{background:#7d826c;background-clip:padding-box;border:3px solid transparent;border-radius:999px}html,body{height:100%;margin:0;overflow:hidden}body{display:flex;flex-direction:column;background:#f3f2ea;color:#1f2117;font:14px/1.5 system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
h1{flex:0 0 auto;margin:0;padding:22px 24px 12px;font-size:18px;line-height:1.3}[role="region"]:focus-visible{outline:none}.body{min-height:0;flex:1 1 auto;overflow:auto;padding:0 24px 20px;color:#3a3e30;white-space:pre-wrap;overflow-wrap:anywhere}.footer{flex:0 0 auto;display:flex;justify-content:flex-end;gap:8px;padding:14px 24px;border-top:1px solid #d3d4c3;background:#fbfaf5}
button{min-width:76px;border:1px solid #7d826c;border-radius:7px;padding:7px 16px;background:#e4e3d6;color:#1f2117;font:inherit}button:hover{background:#d8d7c8}button:focus-visible{outline:2px solid #8f6400;outline-offset:2px}
@media (prefers-color-scheme:dark){*{scrollbar-color:#666 transparent}*::-webkit-scrollbar-thumb{background:#666;background-clip:padding-box}body{background:#171717;color:#f3f3f3}.body{color:#d4d4d4}.footer{border-top-color:#373737;background:#1d1d1d}button{border-color:#666;background:#343434;color:#fff}button:hover{background:#414141}button:focus-visible{outline-color:#89b4fa}}
</style></head><body><h1>${escapeHtml(title)}</h1><div class="body" role="region" aria-label="${escapeHtml(regionLabel)}" tabindex="0">${escapeHtml(message)}</div><div class="footer">${buttons}</div></body></html>`;
}

export interface AppQuestionDialogOptions {
  /** The window the question belongs to; none for a question with no window open. */
  owner?: BrowserWindow;
  title: string;
  message: string;
  labels: string[];
  defaultId: number;
  cancelId: number;
  signal: AbortSignal;
}

/** Standalone questions reuse the message shell and settle on OS cancellation. */
export function showAppQuestionDialog(options: AppQuestionDialogOptions): Promise<number> {
  return showAppDialog({ ...options, button: "ok" });
}

/** App-authored plain message shell for launch recovery and fatal halts. */
export async function showAppMessageDialog(options: AppMessageDialogOptions): Promise<void> {
  await showAppDialog(options);
}

/** Loading/sizing may stall; the displayed user decision has no automatic deadline. */
async function dialogRead<T>(work: Promise<T>, closed: Promise<number>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      closed.then(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("app dialog did not load within 5000 ms")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function showAppDialog(options: AppMessageDialogOptions & Partial<AppQuestionDialogOptions>): Promise<number> {
  const { owner, title, message, button, signal, labels, defaultId = 0, cancelId = 0 } = options;
  if (signal?.aborted) return cancelId;
  const translator = mainTranslator();
  const win = new BrowserWindow({
    width: 520,
    height: 280,
    minWidth: 420,
    minHeight: MESSAGE_DIALOG_MIN_HEIGHT,
    maxWidth: 760,
    maxHeight: MESSAGE_DIALOG_MAX_HEIGHT,
    parent: owner,
    modal: owner !== undefined,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    title,
    backgroundColor: windowBackground(),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  let answer: number | undefined;
  let settle!: (choice: number) => void;
  const closed = new Promise<number>((resolve) => { settle = resolve; });
  const finish = (choice: number): void => {
    if (answer !== undefined) return;
    answer = choice;
    settle(choice);
    if (!win.isDestroyed()) win.destroy();
  };
  const abort = (): void => finish(cancelId);
  win.once("closed", () => finish(cancelId));
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (!labels) return;
    const match = /^zipkit-dialog-choice:\/\/(\d+)\/?$/.exec(url);
    if (match && Number(match[1]) < labels.length) finish(Number(match[1]));
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") { event.preventDefault(); finish(cancelId); }
  });
  signal?.addEventListener("abort", abort, { once: true });
  const html = buildAppMessageDialogDocument({
    lang: translator.language,
    title,
    message,
    buttonLabel: translator.t(button === "ok" ? "messageDialog.ok" : "messageDialog.quit"),
    regionLabel: translator.t("messageDialog.details", { title }),
    ...(labels ? { choices: { labels, defaultId } } : {}),
  });
  try {
    await dialogRead(win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`), closed);
    if (answer !== undefined) return answer;
    try {
      const naturalContentHeight = Number(await dialogRead(win.webContents.executeJavaScript(`(() => {
        const header = document.querySelector("h1");
        const body = document.querySelector(".body");
        const footer = document.querySelector(".footer");
        if (!header || !body || !footer) return NaN;
        return Math.ceil(header.getBoundingClientRect().height + body.scrollHeight + footer.getBoundingClientRect().height);
      })()`), closed));
      if (answer !== undefined) return answer;
      const size = win.getSize();
      const contentSize = win.getContentSize();
      const frameHeight = Math.max(0, (size[1] ?? 280) - (contentSize[1] ?? 280));
      if (Number.isFinite(naturalContentHeight)) {
        win.setSize(size[0] ?? 520, boundedMessageDialogHeight(naturalContentHeight, frameHeight), false);
      }
    } catch (error) {
      console.error("failed to size app message dialog", error);
    }
    if (answer !== undefined) return answer;
    win.show();
    return await closed;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!win.isDestroyed()) win.destroy();
  }
}

/** The fatal launch message, in the interface language (the computer's when
 *  the saved choice could not be read). */
export async function notifyStartupFailure(message: MessageKey, values?: MessageValues): Promise<void> {
  const translator = await settledTranslator();
  return showAppMessageDialog({
    title: translator.t("startup.title"),
    message: translator.t(message, values),
    button: "quit",
  });
}
