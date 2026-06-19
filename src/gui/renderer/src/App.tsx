/**
 * The queue screen. A bottom-bordered header (title + hamburger menu), a body of
 * rounded panes — the job list on the left, and on the right the selected job's
 * parameters over its output over the always-visible activity log — and a status
 * bar. Add jobs (planned in the background), tune each job's parameters and
 * intent, then Start to drain the ready jobs one write at a time. Everything shown
 * is a field the SDK returned, surfaced through the main-process queue; the view
 * sequences queue commands and renders, it computes no archive logic. Defaults for
 * new jobs live in Settings (saved across launches).
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ExtractData, Finding, Job, JobIntent, PlanData } from "../../shared/api";
import type { LogEvent } from "../../shared/api";
import { DEFAULT_OPTIONS, type GuiOptions } from "../../shared/spec";
import { AboutDialog } from "./components/AboutDialog";
import { ActivityLog } from "./components/ActivityLog";
import { AppHeader } from "./components/AppHeader";
import { useConfirm } from "./components/DialogHost";
import { JobListbox } from "./components/JobListbox";
import { OptionsPanel } from "./components/OptionsPanel";
import { Pane } from "./components/Pane";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { StateBadge } from "./components/StateBadge";
import { StatusBar } from "./components/StatusBar";
import {
  archiveName,
  COLOR,
  droppedEntries,
  isEditable,
  isTerminal,
  label,
  manifestRequiredButMissing,
  severityColor,
  verdictHeadline,
  verifySummary,
} from "./view";

type DialogName = "settings" | "shortcuts" | "about";

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<GuiOptions>(DEFAULT_OPTIONS);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const saveDefaults = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = window.zipkit.onQueue(setJobs);
    void window.zipkit.getQueue().then(setJobs); // initial list (incl. restored jobs)
    void window.zipkit.getSettings().then(setDefaults); // persisted defaults for new jobs
    return unsubscribe;
  }, []);
  useEffect(
    () => window.zipkit.onEvent((e) => setEvents((prev) => [...prev.slice(-299), e])),
    [],
  );

  // Cmd/Ctrl+, opens Settings; Cmd/Ctrl+/ opens Shortcuts (modal-dialog
  // conventions). Suppressed while any modal is open — the dialog owns the keys —
  // and inert during IME composition.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === ",") {
        e.preventDefault();
        setDialog("settings");
      } else if (e.key === "/") {
        e.preventDefault();
        setDialog("shortcuts");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const anyReady = jobs.some((j) => j.state === "ready");

  // Defaults live-apply and are saved (debounced) so they persist across launches.
  function changeDefaults(next: GuiOptions) {
    setDefaults(next);
    clearTimeout(saveDefaults.current);
    saveDefaults.current = setTimeout(() => void window.zipkit.setSettings(next), 300);
  }

  async function addJob() {
    const inputs = await window.zipkit.chooseInputs();
    if (inputs.length === 0) return;
    const id = await window.zipkit.addJob(inputs, defaults, "save");
    setSelectedId(id);
  }

  return (
    <div style={S.shell}>
      <AppHeader
        onOpenSettings={() => setDialog("settings")}
        onOpenShortcuts={() => setDialog("shortcuts")}
        onOpenAbout={() => setDialog("about")}
      />

      <div style={S.body}>
        <Pane
          title="Jobs"
          actions={
            <>
              <button className="accent" onClick={() => void addJob()}>
                Add
              </button>
              <button onClick={() => void window.zipkit.startQueue()} disabled={!anyReady}>
                Start
              </button>
            </>
          }
          bodyStyle={S.listBody}
        >
          <JobListbox
            jobs={jobs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={(id) => void window.zipkit.removeJob(id)}
            onCancel={(id) => void window.zipkit.cancelJob(id)}
          />
        </Pane>

        <div style={S.rightCol}>
          {selected ? (
            <JobView key={selected.id} job={selected} />
          ) : (
            <>
              <Pane title="Parameters">
                <p style={S.muted}>Add or select a job to see its archive and parameters.</p>
              </Pane>
              <Pane title="Output">
                <p style={S.muted}>No job selected.</p>
              </Pane>
            </>
          )}
          <Pane title="Activity log">
            <ActivityLog events={events} />
          </Pane>
        </div>
      </div>

      <StatusBar />

      {dialog === "settings" && (
        <SettingsDialog
          defaults={defaults}
          onChange={changeDefaults}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "about" && <AboutDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function JobView({ job }: { job: Job }) {
  const confirm = useConfirm();
  // Keyed by job id in the parent, so this remounts per job — local option draft,
  // the parameter lock, and verify state start fresh, no manual re-sync needed.
  const [opts, setOpts] = useState<GuiOptions>(job.options);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [verify, setVerify] = useState<ExtractData | null>(null);
  // Parameters are locked by default: archiving is high-stakes, the shipped
  // defaults are good, so the user opts in to overriding them per job.
  const [locked, setLocked] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Fetch the full plan for the detail whenever this job is (re)planned.
  useEffect(() => {
    let live = true;
    void window.zipkit.getPlan(job.id).then((p) => {
      if (live) setPlan(p);
    });
    return () => {
      live = false;
    };
  }, [job.id, job.state, job.summary]);

  function changeOptions(next: GuiOptions) {
    setOpts(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void window.zipkit.updateJob(job.id, { options: next }), 250);
  }

  async function changeIntent(intent: JobIntent) {
    if (intent === "archive-and-trash") {
      const ok = await confirm({
        title: "Move originals to Trash after archiving?",
        message: `When this job runs, its ${job.inputs.length} item(s) will be moved to the Trash after the archive is written and verified. They are kept if writing or verification fails.`,
        confirmLabel: "Set to move to Trash",
        danger: true,
      });
      if (!ok) return;
    }
    await window.zipkit.updateJob(job.id, { intent });
  }

  const editable = isEditable(job.state);
  const terminal = isTerminal(job.state);
  const canVerify = job.state === "done" && job.intent === "save" && !!job.output;
  const target = archiveName(job.output) || `${label(job)} (planning…)`;

  return (
    <>
      <Pane
        title="Parameters"
        actions={
          canVerify ? (
            <button
              onClick={() =>
                void window.zipkit
                  .verify(job.output!, job.options.metadata)
                  .then((r) => r.ok && setVerify(r.data))
              }
            >
              Verify
            </button>
          ) : undefined
        }
      >
        {/* The identity a user reasons about is the target .zip, not the source. */}
        <div style={S.targetName} title={job.output}>
          {target}
        </div>
        <div style={S.metaRow}>
          <StateBadge state={job.state} />
          <span style={S.muted}>from {label(job)}</span>
        </div>
        {job.message && <p style={S.muted}>{job.message}</p>}

        <label style={S.intent}>
          <span style={{ color: "var(--text-2)" }}>Intent</span>{" "}
          <select
            value={job.intent}
            disabled={!editable}
            onChange={(e) => void changeIntent(e.target.value as JobIntent)}
          >
            <option value="save">Save archive</option>
            <option value="archive-and-trash">Archive &amp; move originals to Trash</option>
          </select>
        </label>
        {manifestRequiredButMissing(job.intent, opts.metadata) && (
          <p style={{ color: COLOR.warn }}>Enable “Embed manifest” — verify-before-Trash needs it.</p>
        )}

        {!terminal && (
          <>
            <label style={S.lock}>
              <input
                type="checkbox"
                checked={locked}
                disabled={!editable}
                onChange={(e) => setLocked(e.target.checked)}
              />
              <span>Lock parameters {locked && <span style={S.muted}>(using defaults)</span>}</span>
            </label>
            <OptionsPanel options={opts} onChange={changeOptions} disabled={locked || !editable} />
          </>
        )}
      </Pane>

      <Pane title="Output">
        {plan && !terminal && (
          <>
            <h3 style={{ color: plan.writable ? COLOR.ok : COLOR.bad, margin: "0 0 0.5rem" }}>
              {verdictHeadline(plan)}
            </h3>
            <p style={S.muted}>
              → <code>{plan.output}</code> — {plan.summary.included} included,{" "}
              {plan.summary.excluded} dropped, {plan.summary.warnings} warning(s),{" "}
              {plan.summary.errors} blocking
            </p>
            <FindingsList findings={plan.findings} />
            <Dropped plan={plan} />
          </>
        )}
        {verify && <VerifyView data={verify} />}
        {terminal && !verify && <p style={S.muted}>{job.message ?? "Finished."}</p>}
      </Pane>
    </>
  );
}

function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <p style={S.muted}>No portability issues.</p>;
  return (
    <ul style={S.list}>
      {findings.map((f, i) => (
        <li key={i}>
          <code style={{ color: severityColor(f.severity) }}>{f.severity}</code> {f.rule} —{" "}
          {f.message} <small style={S.muted}>({f.path})</small>
        </li>
      ))}
    </ul>
  );
}

function Dropped({ plan }: { plan: PlanData }) {
  const dropped = droppedEntries(plan);
  if (dropped.length === 0) return null;
  return (
    <details>
      <summary>{dropped.length} dropped</summary>
      <ul style={S.list}>
        {dropped.map((e, i) => (
          <li key={i}>
            <code>{e.archivePath}</code>{" "}
            <small style={S.muted}>— {e.excludeReason ?? "excluded"}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}

function VerifyView({ data }: { data: ExtractData }) {
  const color = data.reportOk ? COLOR.ok : COLOR.bad;
  return (
    <section style={{ borderLeft: `3px solid ${color}`, paddingLeft: "0.75rem", margin: "0.5rem 0" }}>
      <strong style={{ color }}>{data.reportOk ? "Verified ✓" : "Verification failed"}</strong> —{" "}
      {verifySummary(data)}
      {data.missing.length > 0 && <div>Missing: {data.missing.join(", ")}</div>}
      {data.extra.length > 0 && <div>Extra: {data.extra.join(", ")}</div>}
    </section>
  );
}

const S: Record<string, CSSProperties> = {
  shell: { height: "100%", display: "flex", flexDirection: "column" },
  body: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "19rem 1fr",
    gap: "0.6rem",
    padding: "0.6rem",
  },
  rightCol: {
    display: "grid",
    gridTemplateRows: "1fr 1fr 1fr",
    gap: "0.6rem",
    minHeight: 0,
    minWidth: 0,
  },
  listBody: { display: "flex", padding: "0.5rem", overflow: "hidden" },
  muted: { color: "var(--text-2)", margin: "0.4rem 0" },
  targetName: {
    fontSize: "1.05rem",
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  metaRow: { display: "flex", gap: "0.6rem", alignItems: "baseline", margin: "0.25rem 0" },
  intent: { display: "inline-flex", gap: "0.5rem", alignItems: "center", margin: "0.5rem 0" },
  lock: { display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.5rem 0" },
  list: { margin: "0.25rem 0", paddingLeft: "1.25rem" },
};
