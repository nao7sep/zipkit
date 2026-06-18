/**
 * Help dialog (modal-dialog conventions): what the app does and the queue
 * keyboard model, over the shared modal shell.
 */

import { ModalShell } from "./ModalShell";

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="ZipKit help" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <p>
        <strong>Making archives.</strong> “Add job…” picks folders or files; each is planned in the
        background and shows whether it is Windows-safe and what was dropped or fixed. Tune its
        options, then “Start” to write the ready jobs one at a time.
      </p>
      <p>
        <strong>Two intents.</strong> <em>Save archive</em> writes the <code>.zip</code>.{" "}
        <em>Archive &amp; move originals to Trash</em> writes, verifies (CRC plus the manifest), and
        only then moves the originals to the Trash — they are kept on any failure, and it needs the
        manifest embedded.
      </p>
      <p>
        <strong>Verify.</strong> A finished Save job can be re-checked with “Verify”, which re-reads
        the archive from disk.
      </p>
      <p>
        <strong>Queue keys.</strong> Tab moves into and out of the job list as a whole; inside it,
        ↑/↓ and Home/End move, typing a name jumps to it, Delete removes a job, and Esc cancels a
        running one.
      </p>
      <p style={{ opacity: 0.7 }}>
        Each session’s logs are written under the app’s data folder (~/.zipkit/logs by default;
        ZIPKIT_HOME/ZIPKIT_LOG_DIR relocate it).
      </p>
    </ModalShell>
  );
}
