/**
 * Settings dialog (modal-dialog conventions): the defaults applied to every new
 * job. These are set-once-ish, not per-archive knobs, which is why they live here
 * rather than on the main screen. Changes live-apply to the app's default state
 * (an explicit choice — no draft/dirty prompt for a live-apply surface), and a
 * job's own options can still override them in its overrides pane.
 */

import { ModalShell } from "./ModalShell";
import { OptionsPanel } from "./OptionsPanel";
import { DEFAULT_OPTIONS, type GuiOptions } from "../../../shared/spec";

export function SettingsDialog({
  defaults,
  onChange,
  onClose,
}: {
  defaults: GuiOptions;
  onChange: (o: GuiOptions) => void;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title="Settings"
      onClose={onClose}
      describedById="settings-intro"
      footer={
        <>
          <button onClick={() => onChange({ ...DEFAULT_OPTIONS })}>Restore defaults</button>
          <button className="accent" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p id="settings-intro" style={{ marginTop: 0, color: "var(--text-2)" }}>
        Defaults for new jobs — saved as you change them. Each job can still override these once it is
        added. “Restore defaults” returns every option to the values shipped with the app.
      </p>
      <OptionsPanel options={defaults} onChange={onChange} disabled={false} />
    </ModalShell>
  );
}
