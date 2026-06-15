/**
 * The app's one shared modal shell (modal-dialog conventions). It owns the
 * mechanics only — backdrop, centered surface, `role="dialog"` / `aria-modal` /
 * accessible title, initial focus, focus trap, background scroll-lock, focus
 * restore, and one close path (Escape, backdrop, or the caller's own button all
 * route to `onClose`). Feature modals (confirm, about, help) supply their title,
 * body, and footer; they never re-implement the chrome.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import { isComposing } from "../composition";

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Land on the footer's first control (Cancel/Close — the safe default), else
    // the first focusable in the body, else the surface itself.
    const target =
      footerRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      surfaceRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      surfaceRef.current;
    target?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      // Mid-composition, Escape belongs to the IME (dismiss the candidate), not
      // the dialog — closing here would violate the text-input/IME convention,
      // unlike every other app's ModalShell.
      if (isComposing(e)) return;
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }

  return (
    <div
      style={ST.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={describedById}
        tabIndex={-1}
        style={ST.surface}
        onKeyDown={onKeyDown}
      >
        <h2 id="modal-title" style={{ marginTop: 0 }}>
          {title}
        </h2>
        {children}
        {footer && (
          <div ref={footerRef} style={ST.footer}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

const ST: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  surface: {
    background: "#222",
    color: "#eee",
    padding: "1.25rem",
    borderRadius: 8,
    minWidth: "20rem",
    maxWidth: "34rem",
    maxHeight: "85vh",
    overflowY: "auto",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" },
};
