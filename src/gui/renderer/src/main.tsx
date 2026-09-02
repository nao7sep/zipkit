import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { DialogHost } from "./components/DialogHost";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RendererErrorBoundary>
      <DialogHost>
        <App />
      </DialogHost>
    </RendererErrorBoundary>
  </StrictMode>,
);
