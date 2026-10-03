import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import { denyUnhandledExternalDrop } from "./externalDropBoundary";
import { MainProcessLanguage } from "./i18n/I18nContext";
import { RecordsApp } from "./records/RecordsWindow";
import { installWindowActivityState } from "./windowActivity";

installWindowActivityState(window.zipkit.onWindowActivityChanged, document.documentElement);
// A file dropped anywhere in this window must not navigate it away.
window.addEventListener("dragover", denyUnhandledExternalDrop);
window.addEventListener("drop", denyUnhandledExternalDrop);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RendererErrorBoundary>
      <MainProcessLanguage>
        <RecordsApp />
      </MainProcessLanguage>
    </RendererErrorBoundary>
  </StrictMode>,
);
