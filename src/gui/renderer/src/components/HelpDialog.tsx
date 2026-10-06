/**
 * Help dialog (modal-dialog conventions): for someone sending files to Windows
 * users, what ZipKit detects, what it fixes, and what a ZIP file does not
 * carry, in plain words and in sections. The facts follow the SDK's rules
 * (registry, junk preset, store-only extensions, the writer's clean-byte
 * contract), so a change there is a change here.
 */

import type { CSSProperties } from "react";
import type { MessageKey } from "../../../shared/i18n/catalogues";
import { ModalShell } from "./ModalShell";
import { useI18n } from "../i18n/I18nContext";

const SECTIONS: ReadonlyArray<{ title: MessageKey; items: readonly MessageKey[] }> = [
  {
    title: "help.fixedTitle",
    items: [
      "help.fixedNfc",
      "help.fixedInvalid",
      "help.fixedControl",
      "help.fixedTrailing",
      "help.fixedReserved",
      "help.fixedStrict",
    ],
  },
  { title: "help.flaggedTitle", items: ["help.flaggedHidden", "help.flaggedCollision"] },
  { title: "help.pathsTitle", items: ["help.pathsRoot", "help.pathsLong"] },
  {
    title: "help.contentsTitle",
    items: [
      "help.contentsJunk",
      "help.contentsDuplicate",
      "help.contentsEmpty",
      "help.contentsSymlinks",
      "help.contentsSpecial",
      "help.contentsDates",
    ],
  },
  {
    title: "help.archiveTitle",
    items: [
      "help.archiveUtf8",
      "help.archiveModes",
      "help.archiveZip64",
      "help.archiveStored",
      "help.archiveSafe",
      "help.archiveManifest",
    ],
  },
  { title: "help.notCarriedTitle", items: ["help.notCarriedAttributes"] },
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <ModalShell
      title={t("help.title")}
      onClose={onClose}
      footer={<button onClick={onClose}>{t("common.close")}</button>}
    >
      <div style={S.body}>
        <p style={S.intro}>{t("help.intro")}</p>
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h3 style={S.title}>{t(section.title)}</h3>
            <ul style={S.list}>
              {section.items.map((item) => (
                <li key={item} style={S.item}>
                  {t(item)}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  body: { display: "grid", gap: "1.1rem" },
  intro: { margin: 0, fontSize: "0.9rem" },
  title: {
    margin: "0 0 0.4rem",
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
  },
  list: { margin: 0, paddingInlineStart: "1.1rem", display: "grid", gap: "0.35rem" },
  item: { fontSize: "0.9rem", lineHeight: 1.45 },
};
