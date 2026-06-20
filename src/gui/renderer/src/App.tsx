/**
 * The queue screen: a bottom-bordered header (title + hamburger menu), a body of
 * three rounded panes split by drag handles (the side widths persist), and a
 * status bar. Left, the job list (Add). Middle, the selected job's everything in
 * one scrollable pane, titled with the job's input inventory and a state pill:
 * its Inputs (add/remove without rebuilding the job), its Parameters (the archive
 * knobs + an output-directory group, gated by a "use default parameters" toggle),
 * its Operation (file name, intent, the full output-path checkpoint, then the
 * lifecycle buttons), and its Report. Right, this job's live Progress. Jobs are
 * planned in the background; each is created on demand and the engine runs them
 * one at a time. The view sequences queue commands and renders, it computes no
 * archive logic. Defaults for new jobs live in Settings (a draft form, saved on
 * commit); the pane widths live in a separate layout store.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ExtractData, GuiLogEvent, Job, JobIntent, PlanData } from "../../shared/api";
import { DEFAULT_OPTIONS, type GuiOptions } from "../../shared/spec";
import { DEFAULT_LAYOUT, clampLayout, type PaneLayout } from "../../shared/layout";
import { AboutDialog } from "./components/AboutDialog";
import { ActivityLog } from "./components/ActivityLog";
import { AppHeader } from "./components/AppHeader";
import { CommandBar } from "./components/CommandBar";
import { useConfirm } from "./components/DialogHost";
import { InputList } from "./components/InputList";
import { JobListbox } from "./components/JobListbox";
import { OptionsPanel } from "./components/OptionsPanel";
import { Pane } from "./components/Pane";
import { Report } from "./components/Report";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Splitter } from "./components/Splitter";
import { StateBadge } from "./components/StateBadge";
import { StatusBar } from "./components/StatusBar";
import {
  archiveName,
  COLOR,
  containingDir,
  isEditable,
  type JobCommand,
  label,
  manifestRequiredButMissing,
} from "./view";

type DialogName = "settings" | "shortcuts" | "about";

const GROW: CSSProperties = { flex: 1 };

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<GuiOptions>(DEFAULT_OPTIONS);
  const [events, setEvents] = useState<GuiLogEvent[]>([]);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  // The persisted side-column widths; the middle Archive column flexes to fill.
  const [layout, setLayout] = useState<PaneLayout>(DEFAULT_LAYOUT);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dragBase = useRef<PaneLayout>(layout);

  useEffect(() => {
    const unsubscribe = window.zipkit.onQueue(setJobs);
    void window.zipkit.getQueue().then(setJobs); // initial list (incl. restored jobs)
    void window.zipkit.getSettings().then(setDefaults); // persisted defaults for new jobs
    void window.zipkit.getLayout().then(setLayout); // persisted pane widths
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
  // The queue is held oldest-first; show it newest-first so a just-added job is
  // at the top, where the user is looking.
  const jobsNewestFirst = [...jobs].reverse();

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

  const persistLayout = () => void window.zipkit.setLayout(layoutRef.current);
  // The Jobs|Archive handle: drag right widens Jobs. The Archive|Progress handle
  // (rendered inside the middle column) drags right to widen Archive (narrow
  // Progress). Both clamp into bounds and persist on release.
  const jobsSplitter = (
    <Splitter
      onDragStart={() => (dragBase.current = layoutRef.current)}
      onDragDelta={(dx) =>
        setLayout(clampLayout({ ...dragBase.current, jobsWidth: dragBase.current.jobsWidth + dx }))
      }
      onDragEnd={persistLayout}
    />
  );
  const progressSplitter = (
    <Splitter
      onDragStart={() => (dragBase.current = layoutRef.current)}
      onDragDelta={(dx) =>
        setLayout(
          clampLayout({ ...dragBase.current, progressWidth: dragBase.current.progressWidth - dx }),
        )
      }
      onDragEnd={persistLayout}
    />
  );

  // Five tracks: Jobs | handle | Archive (flex) | handle | Progress.
  const bodyStyle: CSSProperties = {
    ...S.body,
    gridTemplateColumns: `${layout.jobsWidth}px 0.6rem minmax(0, 1fr) 0.6rem ${layout.progressWidth}px`,
  };

  return (
    <div style={S.shell}>
      <AppHeader
        onOpenSettings={() => setDialog("settings")}
        onOpenShortcuts={() => setDialog("shortcuts")}
        onOpenAbout={() => setDialog("about")}
      />

      <div style={bodyStyle}>
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
            jobs={jobsNewestFirst}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={(id) => void window.zipkit.removeJob(id)}
            onCancel={(id) => void window.zipkit.cancelJob(id)}
          />
        </Pane>

        {jobsSplitter}

        {selected ? (
          <JobView key={selected.id} job={selected} events={events} splitter={progressSplitter} />
        ) : (
          <>
            <Pane title="Archive" rootStyle={GROW}>
              <p style={S.muted}>Add or select a job.</p>
            </Pane>
            {progressSplitter}
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

function JobView({
  job,
  events,
  splitter,
}: {
  job: Job;
  events: GuiLogEvent[];
  splitter: ReactNode;
}) {
  // Keyed by job id in the parent, so this remounts per job: local option draft,
  // the use-defaults toggle, and verify state start fresh, no manual re-sync.
  const [opts, setOpts] = useState<GuiOptions>(job.options);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [verify, setVerify] = useState<ExtractData | null>(null);
  const confirm = useConfirm();
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

  // Clear a stale verify result whenever the job leaves "done" (re-planned, or its
  // archive removed) — a "Verified" line must never linger past the archive it
  // described.
  useEffect(() => {
    if (job.state !== "done") setVerify(null);
  }, [job.state]);

  function changeOptions(next: GuiOptions) {
    setOpts(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void window.zipkit.updateJob(job.id, { options: next }), 250);
  }
  // Commit immediately (used by text fields on blur, so typing doesn't re-plan
  // per keystroke — the engine only re-plans when a plan-affecting option lands).
  function commitOptions(next: GuiOptions) {
    setOpts(next);
    clearTimeout(timer.current);
    void window.zipkit.updateJob(job.id, { options: next });
  }

  // No confirmation here: choosing an intent only edits a parameter — nothing is
  // moved or deleted until the job actually runs, and the move-to-Trash
  // consequence is surfaced on that run path, not on this selection.
  function changeIntent(intent: JobIntent) {
    void window.zipkit.updateJob(job.id, { intent });
  }

  // Input CRUD: add appends paths (from the picker or a drop), skipping ones
  // already in the job; remove drops one. Both re-plan + re-classify in the engine.
  function addPaths(paths: string[]) {
    const next = [...job.inputs, ...paths.filter((p) => p && !job.inputs.includes(p))];
    if (next.length === job.inputs.length) return; // nothing new
    void window.zipkit.updateJob(job.id, { inputs: next });
  }
  async function addInputs() {
    addPaths(await window.zipkit.chooseInputs());
  }
  function onDropFiles(files: File[]) {
    addPaths(files.map((f) => window.zipkit.pathForFile(f)));
  }
  function removeInput(path: string) {
    if (job.inputs.length <= 1) return; // a job must archive something
    void window.zipkit.updateJob(job.id, { inputs: job.inputs.filter((p) => p !== path) });
  }

  async function onCommand(c: JobCommand) {
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
      case "trash-originals":
        // Destructive and not part of the normal run path, so confirm explicitly.
        if (
          await confirm({
            title: "Move originals to Trash?",
            message:
              "The original files and directories for this job will be moved to the Trash. The archive is kept.",
            confirmLabel: "Move to Trash",
            danger: true,
          })
        )
          void window.zipkit.trashOriginals(job.id);
        break;
      case "remove-archive":
        void window.zipkit.removeArchive(job.id);
        break;
    }
  }

  const editable = isEditable(job.state);
  const target = archiveName(job.output) || "(planning…)";
  // Where the .zip lands: its own directory once planned, else the input's parent
  // (the SDK's beside-the-input default), so the checkpoint reads immediately.
  const destDir = containingDir(job.output) || containingDir(job.inputs[0]);
  const jobEvents = events.filter((e) => e.jobId === job.id);

  return (
    <>
      <Pane title={label(job)} rootStyle={GROW} actions={<StateBadge state={job.state} />}>
        {/* Inputs lead the pane: what this job archives, add/remove without
            rebuilding it. */}
        <InputList
          job={job}
          editable={editable}
          onAdd={() => void addInputs()}
          onRemove={removeInput}
          onDropFiles={onDropFiles}
        />

        {/* Parameters: the archive knobs, with the use-defaults toggle in the
            header and the output-directory group inside. */}
        <div style={S.sectionHead}>
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
              onChange={(e) => setOpts({ ...opts, fileName: e.target.value })}
              onBlur={(e) => commitOptions({ ...opts, fileName: e.target.value })}
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
        {/* The final checkpoint: a small lead-in labels it as information (not a
            control), then the full output directory, a spaced "/" marking the UI
            seam, then the resolved .zip name — both at file-name weight. */}
        <div style={S.pathLabel}>{job.state === "done" ? "Saved to" : "Saves to"}</div>
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

        {/* Report: a context-aware, natural-language log of what the archive does
            for the user, integrated into the same pane. */}
        <div style={S.sectionHead}>
          <span style={S.sectionTitle}>Report</span>
        </div>
        <Report job={job} plan={plan} verify={verify} />
      </Pane>

      {splitter}

      <Pane title="Progress" rootStyle={GROW} bodyStyle={S.progressBody}>
        <ActivityLog events={jobEvents} />
      </Pane>
    </>
  );
}

const S: Record<string, CSSProperties> = {
  shell: { height: "100%", display: "flex", flexDirection: "column" },
  body: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    // gridTemplateColumns is set inline from the persisted layout; the splitter
    // tracks provide the inter-pane spacing, so there is no grid gap.
    gap: 0,
    padding: "0.6rem",
  },
  listBody: { display: "flex", padding: "0.5rem", overflow: "hidden" },
  progressBody: { display: "flex", flexDirection: "column", padding: "0.6rem", overflow: "hidden" },
  muted: { color: "var(--text-2)", margin: "0.4rem 0" },
  // The output checkpoint above Create: a small caption ("Saves to"), then the
  // full directory, a spaced "/" UI seam, then the .zip name. Both parts at
  // file-name weight; the path wraps (a checkpoint must show the whole thing,
  // never truncate it away). No box — emphasized text, not a framed field. It is
  // selectable (so a curious click can copy it) but carries no click action.
  pathLabel: { color: "var(--text-2)", fontSize: "0.85rem", margin: "0.85rem 0 0.15rem" },
  pathPreview: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: "0.25rem 0.5rem",
    margin: "0 0 0.25rem",
    userSelect: "text",
  },
  pathPart: { fontSize: "1rem", fontWeight: 700, wordBreak: "break-all", minWidth: 0 },
  pathSep: { fontSize: "1.35rem", fontWeight: 700, color: "var(--text-2)", padding: "0 0.25rem" },
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
  sectionTitle: {
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
  },
  lock: { display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.85rem" },
};
