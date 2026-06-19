/**
 * About dialog (modal-dialog conventions): app name, version, a short
 * description, repository/issues links, copyright, and license. The version comes
 * from the main process (the renderer can't read package.json); links open in the
 * OS browser via the bridge, never by navigating the renderer window.
 */

import { useEffect, useState } from "react";
import { ModalShell } from "./ModalShell";

const REPO = "https://github.com/nao7sep/zipkit";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ name: string; version: string } | null>(null);
  useEffect(() => {
    void window.zipkit.appInfo().then(setInfo);
  }, []);

  return (
    <ModalShell
      title={`About ${info?.name ?? "ZipKit"}`}
      onClose={onClose}
      describedById="about-description"
      footer={<button onClick={onClose}>Close</button>}
    >
      <p>Version {info?.version ?? "…"}</p>
      <p id="about-description">Clean, portable ZIP archives for macOS and Windows.</p>
      <p>
        <button onClick={() => window.zipkit.openExternal(REPO)}>Repository</button>{" "}
        <button onClick={() => window.zipkit.openExternal(`${REPO}/issues`)}>Issues</button>
      </p>
      <p style={{ opacity: 0.7 }}>© {new Date().getFullYear()} Yoshinao Inoguchi · MIT License</p>
    </ModalShell>
  );
}
