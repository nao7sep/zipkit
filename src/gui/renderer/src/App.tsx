/**
 * The queue screen: a bottom-bordered header (title + hamburger menu), a body of
 * three rounded panes, and a status bar. Left, the job list (Add). Middle, the
 * selected job's everything in one scrollable pane, titled with the job's input
 * inventory and a state pill: its Parameters (the archive knobs + an output-folder
 * group, gated by a "use default parameters" toggle), its Operation (file name,
 * intent, the full output-path checkpoint, then the lifecycle buttons), and its
 * Report. Right, this job's live Progress. Jobs are planned in the background;
 * each is created on demand and the engine runs them one at a time. The view
 * sequences queue commands and renders, it computes no archive logic. Defaults
 * for new jobs live in Settings (a draft form, saved on commit).
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ExtractData, Finding, GuiLogEvent, Job, JobIntent, PlanData } from "../../shared/api";
import { DEFAULT_OPTIONS, type GuiOptions } from "../../shared/spec";
import { AboutDialog } from "./components/AboutDialog";
import { ActivityLog } from "./components/ActivityLog";
import { AppHeader } from "./components/AppHeader";
import { CommandBar } from "./components/CommandBar";
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
  containingDir,
  droppedEntries,
  isEditable,
  isTerminal,
  type JobCommand,
  label,
  manifestRequiredButMissing,
  severityColor,
  severityLabel,
  verdictHeadline,
  verifySummary,
} from "./view";

type DialogName = "settings" | "shortcuts" | "about";

const GROW: CSSProperties = { flex: 1 };

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<GuiOptions>(DEFAULT_OPTIONS);
  const [events, setEvents] = useState<GuiLogEvent[]>([]);
  const [dialog, setDialog] = useState<DialogName | null>(null);

  useEffect(() => {
    const unsubscribe = window.zipkit.onQueue(setJobs);
    void window.zipkit.getQueue().then(setJobs); // initial list (incl. restored jobs)
    void window.zipkit.getSettings().then(setDefaults); // persisted defaults for new jobs
    return unsubscribe;
  }, []);
  useEffect(
    () => window.zipkit.onEvent((e) => setEvents((prev) => [...prev.slice(-999), e])),
    [],
  );

  // Cmd/Ctrl+, opens Settings; Cmd/Ctrl+/ opens Shortcuts (modal-dialog
  // conventions). Suppressed while any modal is open and inert during IME composition.
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

  // Defaults are committed only when the user saves the Settings dialog (a draft
  // form), then persisted so they survive across launches.
  function saveDefaults(next: GuiOptions) {
    setDefaults(next);
    void window.zipkit.setSettings(next);
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
            <button className="accent" onClick={() => void addJob()}>
              Add
            </button>
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

        {selected ? (
          <JobView key={selected.id} job={selected} events={events} />
        ) : (
          <>
            <Pane title="Archive" rootStyle={GROW}>
              <p style={S.muted}>Add or select a job.</p>
            </Pane>
            <Pane title="Progress" rootStyle={GROW}>
              <p style={S.muted}>No job selected.</p>
            </Pane>
          </>
        )}
      </div>

      <StatusBar />

      {dialog === "settings" && (
        <SettingsDialog
          defaults={defaults}
          onSave={saveDefaults}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "about" && <AboutDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function JobView({ job, events }: { job: Job; events: GuiLogEvent[] }) {
  // Keyed by job id in the parent, so this remounts per job: local option draft,
  // the use-defaults toggle, and verify state start fresh, no manual re-sync.
  const [opts, setOpts] = useState<GuiOptions>(job.options);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [verify, setVerify] = useState<ExtractData | null>(null);
  // New jobs use the shipped defaults: archiving is high-stakes and the defaults
  // are good, so the user opts IN to customizing this job by unchecking the box.
  const [useDefaults, setUseDefaults] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  // No confirmation here: choosing an intent only edits a parameter — nothing is
  // moved or deleted until the job actually runs, and the move-to-Trash
  // consequence is surfaced on that run path, not on this selection.
  function changeIntent(intent: JobIntent) {
    void window.zipkit.updateJob(job.id, { intent });
  }

  function onCommand(c: JobCommand) {
    switch (c) {
      case "create":
      case "retry":
        void window.zipkit.runJob(job.id);
        break;
      case "cancel":
        void window.zipkit.cancelJob(job.id);
        break;
      case "verify":
        if (job.output)
          void window.zipkit
            .verify(job.id, job.output, job.options.metadata)
            .then((r) => r.ok && setVerify(r.data));
        break;
      case "reveal":
        if (job.output) window.zipkit.reveal(job.output);
        break;
      case "remove-archive":
        void window.zipkit.removeArchive(job.id);
        break;
    }
  }

  const editable = isEditable(job.state);
  const terminal = isTerminal(job.state);
  const target = archiveName(job.output) || "(planning…)";
  // Where the .zip lands: its own folder once planned, else the input's folder
  // (the SDK's beside-the-input default), so the checkpoint reads immediately.
  const destDir = containingDir(job.output) || containingDir(job.inputs[0]);
  const jobEvents = events.filter((e) => e.jobId === job.id);

  const headline = !plan
    ? ""
    : job.state === "done"
      ? "Done ✓"
      : job.state === "failed"
        ? "Failed"
        : verdictHeadline(plan);
  const headlineColor = job.state === "failed" || (plan && !plan.writable) ? COLOR.bad : COLOR.ok;

  return (
    <>
      <Pane title={label(job)} rootStyle={GROW} actions={<StateBadge state={job.state} />}>
        {/* Parameters first (no divider above it): the archive knobs, with the
            use-defaults toggle in the header and output folder + overwrite as a
            group inside. */}
        <div style={S.firstSectionHead}>
          <span style={S.sectionTitle}>Parameters</span>
          <label style={S.lock}>
            <input
              type="checkbox"
              checked={useDefaults}
              disabled={!editable}
              onChange={(e) => setUseDefaults(e.target.checked)}
            />
            <span>Use default parameters</span>
          </label>
        </div>
        <OptionsPanel options={opts} onChange={changeOptions} disabled={useDefaults || !editable} />

        {/* Operation: the per-archive name and intent, then the output path as the
            final checkpoint right above Create, then the lifecycle buttons. */}
        <div style={S.sectionHead}>
          <span style={S.sectionTitle}>Operation</span>
        </div>
        <div style={S.opsGrid}>
          <label style={S.stack}>
            <span style={S.stackLabel}>File name</span>
            <input
              type="text"
              value={opts.fileName}
              placeholder={archiveName(job.output) || "(automatic)"}
              disabled={!editable}
              onChange={(e) => changeOptions({ ...opts, fileName: e.target.value })}
            />
          </label>
          <label style={S.stack}>
            <span style={S.stackLabel}>Intent</span>
            <select
              value={job.intent}
              disabled={!editable}
              onChange={(e) => changeIntent(e.target.value as JobIntent)}
            >
              <option value="save">Save archive</option>
              <option value="archive-and-trash">Archive &amp; move originals to Trash</option>
            </select>
          </label>
        </div>
        {/* The final checkpoint: the full output directory, a spaced "/" marking
            the UI seam, then the resolved .zip name — both at file-name weight. */}
        <div style={S.pathPreview}>
          <span style={S.pathPart} title={destDir || undefined}>
            {destDir || "(beside the input)"}
          </span>
          <span style={S.pathSep}>/</span>
          <span style={S.pathPart} title={target}>
            {target}
          </span>
        </div>
        {manifestRequiredButMissing(job.intent, opts.metadata) && (
          <p style={{ color: COLOR.warn, margin: "0.5rem 0 0" }}>
            Enable “Embed manifest”. Verify-before-Trash needs it.
          </p>
        )}
        <CommandBar job={job} onCommand={onCommand} />

        {/* Report: the plan/result, integrated into the same pane. */}
        <div style={S.sectionHead}>
          <span style={S.sectionTitle}>Report</span>
          {headline && (
            <strong style={{ color: headlineColor, fontSize: "0.9rem" }}>{headline}</strong>
          )}
        </div>
        {plan ? (
          <>
            <p style={S.muted}>
              → <code>{plan.output}</code>: {plan.summary.included} included,{" "}
              {plan.summary.excluded} dropped, {plan.summary.warnings} warning(s),{" "}
              {plan.summary.errors} blocking
            </p>
            <FindingsList findings={plan.findings} />
            <Dropped plan={plan} />
          </>
        ) : (
          <p style={S.muted}>No report yet.</p>
        )}
        {terminal && job.message && <p style={S.muted}>{job.message}</p>}
        {verify && <VerifyView data={verify} />}
      </Pane>

      <Pane title="Progress" rootStyle={GROW} bodyStyle={S.progressBody}>
        <ActivityLog events={jobEvents} />
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
          <code style={{ color: severityColor(f.severity) }}>{severityLabel(f.severity)}</code>{" "}
          {f.rule}: {f.message} <small style={S.muted}>({f.path})</small>
        </li>
      ))}
    </ul>
  );
}

function Dropped({ plan }: { plan: PlanData }) {
  const dropped = droppedEntries(plan);
  if (dropped.length === 0) return null;
  // Never folded: a dropped file the user expected to keep is exactly what they
  // must see, so the whole list is always visible (no <details>/summary).
  return (
    <>
      <p style={S.droppedHead}>{dropped.length} dropped (not included in the archive):</p>
      <ul style={S.list}>
        {dropped.map((e, i) => (
          <li key={i}>
            <code>{e.archivePath}</code>{" "}
            <small style={S.muted}>· {e.excludeReason ?? "excluded"}</small>
          </li>
        ))}
      </ul>
    </>
  );
}

function VerifyView({ data }: { data: ExtractData }) {
  const color = data.reportOk ? COLOR.ok : COLOR.bad;
  return (
    <section style={{ margin: "0.5rem 0" }}>
      <strong style={{ color }}>{data.reportOk ? "Verified ✓" : "Verification failed"}</strong>{" "}
      <span style={S.muted}>· {verifySummary(data)}</span>
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
    gridTemplateColumns: "18rem 2fr 1fr",
    gap: "0.6rem",
    padding: "0.6rem",
  },
  listBody: { display: "flex", padding: "0.5rem", overflow: "hidden" },
  progressBody: { display: "flex", flexDirection: "column", padding: "0.6rem", overflow: "hidden" },
  muted: { color: "var(--text-2)", margin: "0.4rem 0" },
  // The output checkpoint above Create: full directory, a spaced "/" UI seam,
  // then the .zip name. Both parts at file-name weight; the path wraps (a
  // checkpoint must show the whole thing, never truncate it away).
  pathPreview: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "0.25rem 0.5rem",
    margin: "0.85rem 0 0.25rem",
    padding: "0.6rem 0.7rem",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
  },
  pathPart: { fontSize: "1rem", fontWeight: 700, wordBreak: "break-all", minWidth: 0 },
  pathSep: { fontSize: "1.35rem", fontWeight: 700, color: "var(--text-2)", padding: "0 0.25rem" },
  droppedHead: { color: "var(--text-2)", margin: "0.5rem 0 0.1rem", fontSize: "0.85rem" },
  opsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
    gap: "0.6rem 1rem",
    alignItems: "end",
  },
  stack: { display: "grid", gap: "0.25rem", minWidth: 0 },
  stackLabel: { color: "var(--text-2)", fontSize: "0.85rem" },
  // Section divider rows inside the single Archive pane (Operation, Report).
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    margin: "1.1rem 0 0.6rem",
    paddingTop: "0.6rem",
    borderTop: "1px solid var(--border)",
  },
  // The first section (Parameters) gets no top rule — it leads the pane.
  firstSectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    margin: "0 0 0.6rem",
  },
  sectionTitle: {
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
  },
  lock: { display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.85rem" },
  list: { margin: "0.25rem 0", paddingLeft: "1.25rem" },
};
