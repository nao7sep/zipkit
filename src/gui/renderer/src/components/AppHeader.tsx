/**
 * The app header (fleet design): a bottom-bordered bar with the app title on the
 * left and a hamburger menu on the right. The menu is Radix's DropdownMenu —
 * battle-tested roving focus, type-ahead, Escape, and outside-click per the
 * composite-control conventions — holding the app's utility surfaces (Settings,
 * Shortcut keys, About). The hamburger is an inline SVG, not a font glyph.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { CSSProperties } from "react";

export function AppHeader({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
}: {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
}) {
  return (
    <header style={S.header}>
      <h1 style={S.title}>ZipKit</h1>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="icon" aria-label="Menu" title="Menu">
            <HamburgerIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-content" align="end" sideOffset={6}>
            <DropdownMenu.Item className="menu-item" onSelect={onOpenSettings}>
              Settings
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={onOpenShortcuts}>
              Shortcut keys
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={onOpenAbout}>
              About
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
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
