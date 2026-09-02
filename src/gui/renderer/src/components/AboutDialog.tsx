/**
 * About dialog (modal-dialog conventions): app name, version, a short
 * description, repository/issues links, copyright, and license. The version comes
 * from the main process (the renderer can't read package.json); links open in the
 * OS browser via the bridge, never by navigating the renderer window.
 */

import { useEffect, useState } from "react";
import { ModalShell } from "./ModalShell";
import { ReceiverResultNotice } from "./ReceiverResultNotice";
import { reportableError } from "../externalDropBoundary";

const REPO = "https://github.com/nao7sep/zipkit";
export const ABOUT_COPYRIGHT = "© 2026 Yoshinao Inoguchi · MIT License";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ name: string; version: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    void window.zipkit.appInfo().then((next) => { if (live) setInfo(next); }).catch((error) => {
      if (!live) return;
      window.zipkit.reportError("load About information", reportableError(error));
      setLoadFailed(true);
    });
    return () => { live = false; };
  }, [attempt]);

  async function openLink(url: string) {
    setLinkError(false);
    try { await window.zipkit.openExternal(url); }
    catch (error) {
      window.zipkit.reportError("open About link", reportableError(error));
      setLinkError(true);
    }
  }

  return (
    <ModalShell
      title={`About ${info?.name ?? "ZipKit"}`}
      onClose={onClose}
      describedById="about-description"
      footer={<button onClick={onClose}>Close</button>}
    >
      {loadFailed ? <><p role="alert">App information could not be loaded. Try again.</p><button onClick={() => setAttempt((value) => value + 1)}>Retry</button></> : <p>Version {info?.version ?? "Loading…"}</p>}
      <p id="about-description">Clean, portable ZIP archives for macOS and Windows.</p>
      <p>
        <button disabled={!info} onClick={() => void openLink(REPO)}>Repository</button>{" "}
        <button disabled={!info} onClick={() => void openLink(`${REPO}/issues`)}>Issues</button>
      </p>
      {linkError && <ReceiverResultNotice result={{ message: "The link could not be opened in your browser. Try again.", severity: "error" }} onDismiss={() => setLinkError(false)} />}
      <p style={{ opacity: 0.7 }}>{ABOUT_COPYRIGHT}</p>
    </ModalShell>
  );
}
