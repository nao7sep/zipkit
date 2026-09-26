/**
 * The app's one shared modal shell (modal-dialog conventions), built on Radix's
 * Dialog primitive. Radix owns the battle-tested mechanics — the focus trap,
 * background scroll-lock, focus restore on close, layered Escape / outside-click
 * dismissal (only the topmost layer reacts), and the `role="dialog"` /
 * `aria-modal` / `aria-labelledby` wiring off the title. This shell adds only the
 * two things the conventions require that Radix does not do on its own, plus the
 * app's dark surface chrome:
 *
 * - Footer-first initial focus: land on the footer's first control (Close /
 *   Cancel — the safe default), never a primary or danger action.
 * - The IME-Escape guard: mid-composition, Escape dismisses the IME candidate,
 *   not the dialog (text-input-and-IME conventions). Radix honors
 *   `defaultPrevented`, so the guard simply prevents the default close.
 *
 * Feature modals (confirm, about, help) supply their title, body, and footer;
 * they never re-implement any of the chrome. One close path: Escape, an
 * outside click, or a caller's own button all settle through `onClose`.
 */

import * as Dialog from "@radix-ui/react-dialog";
import type { CSSProperties, ReactNode } from "react";

import { isComposing } from "../composition";
import { useI18n } from "../i18n/I18nContext";

// A focusable that can actually take focus right now — disabled and
// explicitly-untabbable controls are excluded, so the safe-default focus never
// lands on a dead element. (Radix's trap does its own tabbable detection.)
const FOCUSABLE =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function ModalShell({
  title,
  titleHidden = false,
  onClose,
  children,
  footer,
  describedById,
  maxWidth,
}: {
  title: string;
  /**
   * Keeps the title as the dialog's spoken name but takes it off the screen,
   * for a surface whose own content already says what it is (About). The band
   * then holds only the close control and carries no line, since there is no
   * title to divide from the content.
   */
  titleHidden?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  describedById?: string;
  /** Override the default surface width cap (e.g. a wider settings form). */
  maxWidth?: string;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay style={ST.backdrop} />
        <Dialog.Content
          style={maxWidth ? { ...ST.surface, maxWidth } : ST.surface}
          aria-describedby={describedById}
          onOpenAutoFocus={(e) => {
            const surface = e.currentTarget as HTMLElement | null;
            if (!surface) return;
            // A surface may name the control that takes focus with
            // [data-modal-autofocus] — a confirmation marks its Cancel, so a
            // reflexive Enter can never reach the destructive action even if the
            // footer is reordered. Unmarked surfaces keep the first footer action.
            const footerEl = surface.querySelector<HTMLElement>("[data-modal-footer]");
            const target =
              surface.querySelector<HTMLElement>("[data-modal-autofocus]") ??
              footerEl?.querySelector<HTMLElement>(FOCUSABLE) ??
              surface.querySelector<HTMLElement>(FOCUSABLE) ??
              surface;
            e.preventDefault();
            target.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (isComposing(e)) e.preventDefault();
          }}
        >
          <div style={titleHidden ? ST.titleBarBare : ST.titleBar}>
            <Dialog.Title style={titleHidden ? ST.titleHidden : ST.title}>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" style={ST.close} className="icon" aria-label={t("common.close")} title={t("common.close")}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                  <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </Dialog.Close>
          </div>
          <div style={ST.scroll}>{children}</div>
          {footer && (
            <div data-modal-footer style={ST.footer}>
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ST: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 1000,
  },
  // The surface is a fixed-height flex column: the title and footer stay put and
  // only the middle scrolls, so the accessible title and the close/cancel path are
  // always reachable on a long dialog.
  surface: {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: 1001,
    display: "flex",
    flexDirection: "column",
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    minWidth: "20rem",
    maxWidth: "34rem",
    maxHeight: "85vh",
    overflow: "hidden",
    boxShadow: "var(--modal-shadow)",
  },
  // Title and close control sit in one band, centred, closed by a line. With the
  // title hidden the band keeps only the control — and its corner — and drops
  // the line (modal-dialog conventions).
  titleBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.7rem 1.25rem",
    borderBottom: "1px solid var(--border)",
  },
  titleBarBare: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "0.7rem 1.25rem 0",
  },
  title: {
    margin: 0,
    fontSize: "1.05rem",
  },
  titleHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    border: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  close: {
    display: "inline-grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderRadius: 6,
    background: "transparent",
    color: "var(--text)",
  },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", padding: "1.25rem" },
  footer: {
    flexShrink: 0,
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.75rem",
    padding: "0.85rem 1.25rem",
    borderTop: "1px solid var(--border)",
  },
};
