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

// A focusable that can actually take focus right now — disabled and
// explicitly-untabbable controls are excluded, so the safe-default focus never
// lands on a dead element. (Radix's trap does its own tabbable detection.)
const FOCUSABLE =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function ModalShell({
  title,
  onClose,
  children,
  footer,
  describedById,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  describedById?: string;
}) {
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
          style={ST.surface}
          aria-describedby={describedById}
          onOpenAutoFocus={(e) => {
            const surface = e.currentTarget as HTMLElement | null;
            if (!surface) return;
            const footerEl = surface.querySelector<HTMLElement>("[data-modal-footer]");
            const target =
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
          <Dialog.Title style={ST.title}>{title}</Dialog.Title>
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
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  },
  title: {
    flexShrink: 0,
    margin: 0,
    padding: "1rem 1.25rem",
    fontSize: "1.05rem",
    borderBottom: "1px solid var(--border)",
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
