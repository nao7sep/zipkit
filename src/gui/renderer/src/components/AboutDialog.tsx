/**
 * About dialog (modal-dialog conventions): app name, version, a short
 * description, repository/issues links, copyright, and license. The version comes
 * from the main process (the renderer can't read package.json); links open in the
 * OS browser via the bridge, never by navigating the renderer window.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { ReceiverResultNotice } from "./ReceiverResultNotice";
import { reportableError } from "../externalDropBoundary";
import { useI18n } from "../i18n/I18nContext";
import { message } from "../../../shared/i18n/translate";
import { APP_NAME } from "../../../shared/identity";

const REPO = "https://github.com/nao7sep/zipkit";
export const ABOUT_COPYRIGHT = "© 2026 Yoshinao Inoguchi · GNU GPL v3 or later";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<{ name: string; version: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [linkErrors, setLinkErrors] = useState<Record<"repository" | "issues", boolean>>({
    repository: false,
    issues: false,
  });
  const linkAttempts = useRef<Record<"repository" | "issues", number>>({ repository: 0, issues: 0 });
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

  async function openLink(owner: "repository" | "issues", url: string) {
    const currentAttempt = ++linkAttempts.current[owner];
    setLinkErrors((current) => ({ ...current, [owner]: false }));
    try {
      await window.zipkit.openExternal(url);
    }
    catch (error) {
      window.zipkit.reportError("open About link", reportableError(error));
      if (linkAttempts.current[owner] !== currentAttempt) return;
      setLinkErrors((current) => ({ ...current, [owner]: true }));
    }
  }

  return (
    <ModalShell
      title={t("about.title", { name: info?.name ?? APP_NAME })}
      titleHidden
      onClose={onClose}
      describedById="about-description"
      footer={<button onClick={onClose}>{t("common.close")}</button>}
    >
      <p className="about-name">{info?.name ?? APP_NAME}</p>
      {loadFailed ? <><p role="alert">{t("about.loadFailed")}</p><button onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</button></> : <p className="about-version">{info ? t("about.version", { version: info.version }) : t("about.loading")}</p>}
      <p id="about-description">{t("about.description")}</p>
      <div style={S.links}>
        <button disabled={!info} onClick={() => void openLink("repository", REPO)}>{t("about.repository")}</button>
        <button disabled={!info} onClick={() => void openLink("issues", `${REPO}/issues`)}>{t("about.issues")}</button>
      </div>
      {linkErrors.repository && <ReceiverResultNotice result={{ message: message("about.repositoryFailed"), severity: "error" }} onDismiss={() => setLinkErrors((current) => ({ ...current, repository: false }))} />}
      {linkErrors.issues && <ReceiverResultNotice result={{ message: message("about.issuesFailed"), severity: "error" }} onDismiss={() => setLinkErrors((current) => ({ ...current, issues: false }))} />}
      <p style={{ opacity: 0.7 }}>{ABOUT_COPYRIGHT}</p>
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  // Side-by-side buttons are siblings in a row, not words in a sentence: a real
  // gap between them rather than the single space a text node would give.
  links: { display: "flex", flexWrap: "wrap", gap: "0.5rem", margin: "1rem 0" },
};
