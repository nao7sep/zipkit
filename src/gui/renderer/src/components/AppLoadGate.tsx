/**
 * Root launch gate for required renderer state. The ordinary queue interface is
 * not truthful until queue, settings, and pane layout have all loaded, so this
 * full-window surface replaces it during hydration and after a load failure.
 * It is a root launch gate, not a stacked modal: there is no initialized app to
 * dismiss back to. A failed load offers the one safe recovery action, retrying
 * the complete hydration.
 */

import type { CSSProperties } from "react";

export function AppLoadGate({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <main data-app-load-gate style={S.root}>
      <section
        role={failed ? "alert" : "status"}
        aria-atomic="true"
        aria-labelledby="app-load-gate-title"
        style={S.card}
      >
        <h1 id="app-load-gate-title" style={S.title}>
          {failed ? "ZipKit couldn’t load" : "Loading ZipKit…"}
        </h1>
        {failed ? (
          <>
            <p style={S.message}>
              The queue, settings, and pane layout could not all be loaded. Retry before using
              ZipKit so no partial app state is shown.
            </p>
            <button className="accent" onClick={onRetry}>
              Retry loading
            </button>
          </>
        ) : (
          <p style={S.message}>Loading the queue, settings, and pane layout.</p>
        )}
      </section>
    </main>
  );
}

const S: Record<string, CSSProperties> = {
  root: {
    minHeight: "100%",
    display: "grid",
    placeItems: "center",
    padding: "2rem",
    background: "var(--bg)",
  },
  card: {
    width: "min(32rem, 100%)",
    padding: "1.5rem",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
  },
  title: { margin: "0 0 0.65rem", fontSize: "1.3rem" },
  message: { margin: "0 0 1rem", color: "var(--text-2)" },
};
