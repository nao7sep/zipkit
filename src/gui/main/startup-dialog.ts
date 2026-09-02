import { BrowserWindow } from "electron";

export interface AppMessageDialogOptions {
  owner?: BrowserWindow;
  title: string;
  message: string;
  buttonLabel: "OK" | "Quit";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** App-authored plain message shell for launch recovery and fatal halts. */
export async function showAppMessageDialog({
  owner,
  title,
  message,
  buttonLabel,
}: AppMessageDialogOptions): Promise<void> {
  const win = new BrowserWindow({
    width: 520,
    height: 280,
    minWidth: 420,
    minHeight: 220,
    maxWidth: 760,
    parent: owner,
    modal: owner !== undefined,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    title,
    backgroundColor: "#171717",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#171717;color:#f3f3f3;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
h1{margin:0;padding:22px 24px 12px;font-size:18px;line-height:1.3}.body{overflow:auto;padding:0 24px 20px;color:#d4d4d4;white-space:pre-wrap;overflow-wrap:anywhere}.footer{display:flex;justify-content:flex-end;padding:14px 24px;border-top:1px solid #373737;background:#1d1d1d}
button{min-width:76px;border:1px solid #666;border-radius:7px;padding:7px 16px;background:#343434;color:#fff;font:inherit}button:hover{background:#414141}button:focus-visible{outline:2px solid #89b4fa;outline-offset:2px}
</style></head><body><h1>${escapeHtml(title)}</h1><div class="body">${escapeHtml(message)}</div><div class="footer"><button autofocus onclick="window.close()">${buttonLabel}</button></div></body></html>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.show();
  await new Promise<void>((resolve) => win.once("closed", resolve));
}

export function notifyStartupFailure(message: string): Promise<void> {
  return showAppMessageDialog({
    title: "ZipKit could not start",
    message,
    buttonLabel: "Quit",
  });
}
