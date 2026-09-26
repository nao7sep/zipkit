/**
 * The app header (fleet design): a bottom-bordered bar with the app title on the
 * left and a hamburger menu on the right. The menu is Radix's DropdownMenu —
 * battle-tested roving focus, type-ahead, Escape, and outside-click per the
 * composite-control conventions — holding the app's utility surfaces (Settings,
 * Shortcut keys, About). The hamburger is an inline SVG, not a font glyph.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { CSSProperties } from "react";
import { HamburgerIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";

export function AppHeader({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
}: {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
}) {
  const { t } = useI18n();
  return (
    <header style={S.header}>
      <h1 style={S.title}>ZipKit</h1>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="icon" aria-label={t("header.menu")} title={t("header.menu")}>
            <HamburgerIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-content" align="end" sideOffset={6}>
            <DropdownMenu.Item className="menu-item" onSelect={onOpenSettings}>
              {t("header.settings")}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={onOpenShortcuts}>
              {t("header.shortcuts")}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={onOpenAbout}>
              {t("header.about")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}

const S: Record<string, CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.5rem 1rem",
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
  },
  title: { margin: 0, fontSize: "1rem", fontWeight: 700 },
};
