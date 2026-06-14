/**
 * The app's single, promise-based confirm-dialog host (modal-dialog conventions).
 * `useConfirm()` returns `confirm(opts) => Promise<boolean>` that settles on
 * confirm, cancel, Escape, backdrop click, or host unmount. Requests are queued,
 * so a second confirm raised while one is open lines up and still settles. The
 * dialog chrome (focus, trap, scroll-lock, close routing) is the shared
 * ModalShell; this file owns only the queue and the confirm-specific footer.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ModalShell } from "./ModalShell";

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
  id: number;
  resolve: (value: boolean) => void;
}

export function DialogHost({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const ref = useRef<Pending[]>([]);
  const nextId = useRef(0);
  useEffect(() => {
    ref.current = queue;
  }, [queue]);

  // Queued: concurrent requests line up and each resolves in turn, so no pending
  // promise is ever dropped.
  const confirm = useCallback<Confirm>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setQueue((q) => [...q, { ...opts, resolve, id: nextId.current++ }]);
      }),
    [],
  );

  const settle = useCallback((value: boolean) => {
    const head = ref.current[0];
    if (!head) return;
    head.resolve(value);
    setQueue((q) => q.slice(1));
  }, []);

  // Any still-pending dialogs settle (cancel) if the host unmounts — e.g. app quit.
  useEffect(() => () => ref.current.forEach((p) => p.resolve(false)), []);

  const current = queue[0] ?? null;
  return (
    <DialogContext.Provider value={confirm}>
      {children}
      {/* Keyed by id so each queued dialog mounts fresh (focus + scroll-lock re-run). */}
      {current && <ConfirmDialog key={current.id} options={current} onResult={settle} />}
    </DialogContext.Provider>
  );
}

function ConfirmDialog({ options, onResult }: { options: ConfirmOptions; onResult: (value: boolean) => void }) {
  return (
    <ModalShell
      title={options.title}
      onClose={() => onResult(false)}
      describedById="confirm-message"
      footer={
        <>
          <button onClick={() => onResult(false)}>Cancel</button>
          <button onClick={() => onResult(true)} style={options.danger ? DANGER : undefined}>
            {options.confirmLabel}
          </button>
        </>
      }
    >
      <p id="confirm-message">{options.message}</p>
    </ModalShell>
  );
}

const DANGER: CSSProperties = {
  background: "#c0392b",
  color: "#fff",
  border: "none",
  padding: "0.4rem 0.9rem",
  borderRadius: 4,
};
