/** The app-shell owner for a failed pane-layout save. The visible layout remains
 * in memory and usable; this result persists until a later pane save succeeds or
 * the user dismisses it. */

import type { CSSProperties } from "react";
import { CloseIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";

export function LayoutPersistenceNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" aria-atomic="true" style={S.root}>
      <span style={S.message}>{t("layout.notSaved")}</span>
      <button
        type="button"
        className="icon"
        aria-label={t("layout.close")}
        onClick={onDismiss}
        style={S.dismiss}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  root: {
    flexShrink: 0,
    display: "flex",
    alignItems: "flex-start",
    gap: "0.65rem",
    margin: "0.5rem 0.75rem 0",
    padding: "0.5rem 0.65rem",
    background: "color-mix(in srgb, var(--status-error) 10%, var(--surface-2))",
    border: "1px solid var(--status-error)",
    borderRadius: 6,
    fontSize: "0.85rem",
  },
  message: { flex: 1, minWidth: 0 },
  dismiss: { flexShrink: 0, margin: "-0.25rem -0.35rem -0.25rem 0", padding: 4 },
};
