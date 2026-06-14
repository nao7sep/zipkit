import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DialogHost } from "./components/DialogHost";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DialogHost>
      <App />
    </DialogHost>
  </StrictMode>,
);
