import React from "react";
import { reportableError } from "../externalDropBoundary";
import { documentTranslator } from "../i18n/I18nContext";

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
    // Outside the language provider: speak the language the document last declared.
    const { t } = documentTranslator();
    return (
      <main role="alert" style={styles.root}>
        <div style={styles.card}>
          <h1 style={styles.flush}>{t("crash.title")}</h1>
          <p style={styles.flush}>{t("crash.message")}</p>
          <button style={styles.button} type="button" onClick={() => window.location.reload()}>{t("crash.reload")}</button>
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
