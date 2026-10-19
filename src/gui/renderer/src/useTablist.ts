/**
 * A tablist (composite-control conventions): one tab stop on the selected tab
 * (roving tabindex), Left/Right and Home/End move the selection with no wrap,
 * and selection follows focus, since swapping a panel is a cheap local render.
 * The component owns the `selected` value and renders the panels; this hook
 * owns the keys and the ids that tie each tab to its panel.
 */

import { useCallback, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export interface TabProps {
  role: "tab";
  type: "button";
  tabIndex: 0 | -1;
  "aria-selected": boolean;
  "aria-controls": string;
  id: string;
  ref: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

export interface PanelProps {
  role: "tabpanel";
  id: string;
  "aria-labelledby": string;
}

export function useTablist<T extends string>({
  tabs,
  selected,
  onSelect,
  idBase,
}: {
  tabs: readonly T[];
  selected: T;
  onSelect: (tab: T) => void;
  /** Namespaces the tab and panel ids. */
  idBase: string;
}): { tablistProps: { role: "tablist" }; tabProps: (tab: T) => TabProps; panelProps: (tab: T) => PanelProps } {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (tab: T): string => `${idBase}-tab-${tab}`;
  const panelId = (tab: T): string => `${idBase}-panel-${tab}`;

  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const current = tabs.indexOf(selected);
    let next: number;
    switch (e.key) {
      case "ArrowRight": next = Math.min(current + 1, tabs.length - 1); break;
      case "ArrowLeft": next = Math.max(current - 1, 0); break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    e.preventDefault();
    const target = tabs[next];
    if (target !== undefined && target !== selected) {
      onSelect(target);
      refs.current.get(target)?.focus();
    }
  }, [tabs, selected, onSelect]);

  return {
    tablistProps: { role: "tablist" },
    tabProps: (tab) => ({
      role: "tab",
      type: "button",
      tabIndex: tab === selected ? 0 : -1,
      "aria-selected": tab === selected,
      "aria-controls": panelId(tab),
      id: tabId(tab),
      ref: (el) => { if (el) refs.current.set(tab, el); else refs.current.delete(tab); },
      onClick: () => onSelect(tab),
      onKeyDown,
    }),
    panelProps: (tab) => ({ role: "tabpanel", id: panelId(tab), "aria-labelledby": tabId(tab) }),
  };
}
