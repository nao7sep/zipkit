/// <reference types="vite/client" />

import type { ZipKitGuiApi } from "../../shared/api";

declare global {
  interface Window {
    zipkit: ZipKitGuiApi;
  }
}
