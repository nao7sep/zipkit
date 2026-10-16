/**
 * The app header (fleet design): a bottom-bordered bar with the app title on the
 * left and a hamburger menu on the right. The menu is Radix's DropdownMenu —
 * battle-tested roving focus, type-ahead, Escape, and outside-click per the
 * composite-control conventions — holding the app's utility surfaces (Settings,
 * Records, Shortcut keys, Help, About). The hamburger is an inline SVG, not a font glyph.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { HamburgerIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";
import { isComposing } from "../composition";

// Radix's item defaults focus on pointer movement and return focus to the
// content on leave. Hover must not change the target of arrows or Enter.
const keepMenuTarget = (event: PointerEvent<HTMLDivElement>): void => event.preventDefault();

export function AppHeader({
  onOpenSettings,
  onOpenRecords,
  onOpenShortcuts,
  onOpenAbout,
}: {
  onOpenSettings: () => void;
  onOpenRecords: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const entry = useRef<"first" | "last">("first");
  const commands = [
    { key: "header.settings", onSelect: onOpenSettings },
    { key: "header.records", onSelect: onOpenRecords },
    { key: "header.shortcuts", onSelect: onOpenShortcuts },
    { key: "header.about", onSelect: onOpenAbout },
  ] as const;
  return (
    <header style={S.header}>
      <h1 style={S.title}>ZipKit</h1>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button className="icon" aria-label={t("header.menu")} title={t("header.menu")}
            onPointerDown={() => { entry.current = "first"; }}
            onKeyDown={(event) => {
              if (isComposing(event)) { event.preventDefault(); return; }
              entry.current = event.key === "ArrowUp" ? "last" : "first";
              if (event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
            }}>
            <HamburgerIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-content" align="end" sideOffset={6}
            onEscapeKeyDown={(event) => { if (isComposing(event)) event.preventDefault(); }}
            onFocus={(event) => {
              if (event.target !== event.currentTarget) return;
              event.preventDefault();
              // Initialize real Radix navigation on both opening paths. Native
              // :focus-visible keeps pointer entry quiet and shows keyboard use.
              const items = event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])');
              items[entry.current === "last" ? items.length - 1 : 0]?.focus({ preventScroll: true });
            }}
            onKeyDownCapture={(event) => {
              if (isComposing(event)) { event.preventDefault(); event.stopPropagation(); }
              else if (event.key === "Tab") { event.preventDefault(); setOpen(false); }
            }}>
            {commands.map(({ key, onSelect }) => (
              <DropdownMenu.Item key={key} className="menu-item" onSelect={onSelect}
                onPointerMove={keepMenuTarget} onPointerLeave={keepMenuTarget}>
                {t(key)}
              </DropdownMenu.Item>
            ))}
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
