import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { DialogHost } from "./components/DialogHost";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import { MainProcessLanguage } from "./i18n/I18nContext";
import { installWindowActivityState } from "./windowActivity";

installWindowActivityState(window.zipkit.onWindowActivityChanged, document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RendererErrorBoundary>
      <MainProcessLanguage>
        <DialogHost>
          <App />
        </DialogHost>
      </MainProcessLanguage>
    </RendererErrorBoundary>
  </StrictMode>,
);
