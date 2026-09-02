import React from "react";
import { reportableError } from "../externalDropBoundary";

export class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const diagnostic = reportableError(error);
    diagnostic.stack = [diagnostic.stack, info.componentStack].filter(Boolean).join("\n");
    try {
      window.zipkit.reportError("renderer stopped unexpectedly", diagnostic);
    } catch (logError) {
      console.error("Failed to record renderer failure", logError);
    }
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" style={styles.root}>
        <div style={styles.card}>
          <h1 style={styles.flush}>ZipKit could not keep this window open.</h1>
          <p style={styles.flush}>Reload the window to recover. Your source files and archives are unchanged.</p>
          <button style={styles.button} type="button" onClick={() => window.location.reload()}>Reload window</button>
        </div>
      </main>
    );
  }
}

const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem", background: "var(--bg)", color: "var(--text)" },
  card: { width: "min(100%, 35rem)", display: "grid", gap: "0.75rem" },
  flush: { margin: 0 },
  button: { width: "max-content" },
};
