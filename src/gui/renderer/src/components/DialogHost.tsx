/**
 * The app's single, promise-based confirm-dialog host (the shared modal
 * foundation per the modal-dialog conventions). `useConfirm()` returns a
 * `confirm(opts) => Promise<boolean>` that settles on confirm, cancel, Escape,
 * backdrop click, or host unmount. The ConfirmDialog owns the mechanics: focus
 * the safe default (Cancel) on open and restore it on close, trap Tab, lock
 * background scroll, route every close path to cancel, and style the destructive
 * action as danger with a specific label.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

const DialogContext = createContext<Confirm>(() => Promise.resolve(false));
export const useConfirm = (): Confirm => useContext(DialogContext);

interface Pending extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function DialogHost({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const ref = useRef<Pending | null>(null);
  useEffect(() => {
    ref.current = pending;
  }, [pending]);

  const confirm = useCallback<Confirm>(
    (opts) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  const settle = useCallback((value: boolean) => {
    const p = ref.current;
    ref.current = null;
    setPending(null);
    p?.resolve(value);
  }, []);

  // Any pending dialog settles (cancel) if the host unmounts — e.g. app quit.
  useEffect(() => () => ref.current?.resolve(false), []);

  return (
    <DialogContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog options={pending} onResult={settle} />}
    </DialogContext.Provider>
  );
}

function ConfirmDialog({ options, onResult }: { options: ConfirmOptions; onResult: (value: boolean) => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onResult(false);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = surfaceRef.current?.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
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
        if (e.target === e.currentTarget) onResult(false);
      }}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        style={ST.surface}
        onKeyDown={onKeyDown}
      >
        <h2 id="confirm-title" style={{ marginTop: 0 }}>
          {options.title}
        </h2>
        <p id="confirm-message">{options.message}</p>
        <div style={ST.footer}>
          <button ref={cancelRef} onClick={() => onResult(false)}>
            Cancel
          </button>
          <button onClick={() => onResult(true)} style={options.danger ? ST.danger : undefined}>
            {options.confirmLabel}
          </button>
        </div>
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
    maxWidth: "32rem",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" },
  danger: { background: "#c0392b", color: "#fff", border: "none", padding: "0.4rem 0.9rem", borderRadius: 4 },
};
