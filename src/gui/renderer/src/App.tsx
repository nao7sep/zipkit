/**
 * The queue screen: a bottom-bordered header (title + hamburger menu) and a body
 * of three rounded panes split by drag handles (the side widths persist). Left,
 * the job list (Add). Middle, the selected job's everything in
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ExtractData, GuiLogEvent, Job, JobIntent, PlanData } from "../../shared/api";
import { DEFAULT_OPTIONS, optionsEqual, type GuiOptions } from "../../shared/spec";
import {
  ARCHIVE_MIN_WIDTH,
  BODY_PADDING,
  DEFAULT_LAYOUT,
  SPLITTER_WIDTH,
  clampLayout,
  clampLayoutToWidth,
  type PaneLayout,
} from "../../shared/layout";
import { AboutDialog } from "./components/AboutDialog";
import { AppHeader } from "./components/AppHeader";
import { CommandBar } from "./components/CommandBar";
import { useConfirm } from "./components/DialogHost";
import { InputList } from "./components/InputList";
import { JobListbox } from "./components/JobListbox";
import { OptionsPanel } from "./components/OptionsPanel";
import { Pane } from "./components/Pane";
import { ProgressLog } from "./components/ProgressLog";
import { Report } from "./components/Report";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Splitter } from "./components/Splitter";
import { StateBadge } from "./components/StateBadge";
import {
  archiveName,
  COLOR,
  isEditable,
  type JobCommand,
  label,
  manifestRequiredButMissing,
  outputPreview,
} from "./view";

type DialogName = "settings" | "shortcuts" | "about";

const GROW: CSSProperties = { flex: 1 };

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<GuiOptions>(DEFAULT_OPTIONS);
  const [events, setEvents] = useState<GuiLogEvent[]>([]);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  // The user's INTENT side-column widths, in pixels: the widths the user dragged
  // to. This is the ONLY layout state that is persisted, and it changes ONLY on a
  // splitter drag — never on a window resize. The middle Archive column flexes to
  // fill. The displayed widths are derived from this (see `displayed` below); a
  // window-shrink narrows what's shown without ever touching the stored intent, so
  // re-growing the window returns the panes to exactly the intended widths.
  const [intent, setIntent] = useState<PaneLayout>(DEFAULT_LAYOUT);
  const intentRef = useRef(intent);
  intentRef.current = intent;
  const dragBase = useRef<PaneLayout>(intent);
  // The live body width, kept current by a ResizeObserver. Ephemeral display state
  // only: it drives the width-aware clamp of the displayed widths and is NEVER
  // persisted, so resizing the window leaves the saved layout untouched.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  useEffect(() => {
    const unsubscribe = window.zipkit.onQueue(setJobs);
    void window.zipkit.getQueue().then(setJobs); // initial list (incl. restored jobs)
    void window.zipkit.getSettings().then(setDefaults); // persisted defaults for new jobs
    // Persisted pane widths ARE the intent. Display-time clamping against the live
    // body width (below) keeps the center pane usable on a smaller window without
    // mutating the intent. (A stale fr value from the old conversion reads as tiny
    // px → clampLayout floors it to the column minimum, which is acceptable.)
    void window.zipkit.getLayout().then((loaded) => setIntent(clampLayout(loaded)));
    return unsubscribe;
  }, []);

  // Track the live body width so the displayed widths can be clamped against it.
  // The observer updates ONLY the ephemeral container width — it does not write to
  // or persist the intent. The displayed panes are recomputed in `displayed`.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(
    () => window.zipkit.onEvent((e) => setEvents((prev) => [...prev.slice(-999), e])),
    [],
  );

  // Block the renderer's default file-drop behavior window-wide: without this, a
  // file dropped anywhere OUTSIDE the inputs drop zone makes Chromium navigate the
  // window to that file:// URL — replacing the whole app. The inputs zone's own
  // onDrop still runs (and adds the file); every other drop is just swallowed.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

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

  // The persisted value is the INTENT — and persistence happens ONLY here, in the
  // drag-release handler, never on a window resize.
  const persistLayout = () => void window.zipkit.setLayout(intentRef.current);
  // The Jobs|Archive handle: drag right widens Jobs. The Archive|Progress handle
  // (rendered inside the middle column) drags right to widen Archive (narrow
  // Progress). A drag sets the user's intent (clamped only into the per-column
  // bounds — the live width-aware clamp is applied for DISPLAY, not stored), and
  // persists it on release.
  const jobsSplitter = (
    <Splitter
      onDragStart={() => (dragBase.current = intentRef.current)}
      onDragDelta={(dx) =>
        setIntent(clampLayout({ ...dragBase.current, jobsWidth: dragBase.current.jobsWidth + dx }))
      }
      onDragEnd={persistLayout}
    />
  );
  const progressSplitter = (
    <Splitter
      onDragStart={() => (dragBase.current = intentRef.current)}
      onDragDelta={(dx) =>
        setIntent(
          clampLayout({ ...dragBase.current, progressWidth: dragBase.current.progressWidth - dx }),
        )
      }
      onDragEnd={persistLayout}
    />
  );

  // The DISPLAYED widths fed to the grid: the intent clamped to the live body
  // width, so a window-shrink narrows the panes toward their minimums while a
  // window-grow returns them to the intent. Display-only — never persisted.
  const displayed = useMemo(
    () => clampLayoutToWidth(intent, containerWidth),
    [intent, containerWidth],
  );

  // Five tracks: Jobs | handle | Archive (flex) | handle | Progress. The center
  // track carries a real minimum (ARCHIVE_MIN_WIDTH) so the primary pane can
  // never collapse; the handle tracks and the body padding use the same px
  // constants the window minimum is derived from, so layout and minimum agree.
  const bodyStyle: CSSProperties = {
    ...S.body,
    padding: BODY_PADDING,
    gridTemplateColumns: `${displayed.jobsWidth}px ${SPLITTER_WIDTH}px minmax(${ARCHIVE_MIN_WIDTH}px, 1fr) ${SPLITTER_WIDTH}px ${displayed.progressWidth}px`,
  };

  return (
    <div style={S.shell}>
      <AppHeader
        onOpenSettings={() => setDialog("settings")}
        onOpenShortcuts={() => setDialog("shortcuts")}
        onOpenAbout={() => setDialog("about")}
      />

      <div ref={bodyRef} style={bodyStyle}>
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
          <JobView
            key={selected.id}
            job={selected}
            defaults={defaults}
            events={events}
            splitter={progressSplitter}
          />
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
  defaults,
  events,
  splitter,
}: {
  job: Job;
  defaults: GuiOptions;
  events: GuiLogEvent[];
  splitter: ReactNode;
}) {
  // Keyed by job id in the parent, so this remounts per job: local option draft and
  // verify state start fresh, no manual re-sync.
  const [opts, setOpts] = useState<GuiOptions>(job.options);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [verify, setVerify] = useState<ExtractData | null>(null);
  const confirm = useConfirm();
  // "Use default parameters" is DERIVED from whether the job's options still equal
  // the defaults — not a free-floating flag that could claim "defaults" while the
  // job is actually customized. Unchecking enables editing; re-checking restores
  // the defaults (see toggleUseDefaults).
  const [useDefaults, setUseDefaults] = useState(() => optionsEqual(job.options, defaults));
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
  // Unchecking enables editing (options unchanged until the user edits); re-checking
  // actually restores the defaults, so the box can never claim "defaults" falsely.
  function toggleUseDefaults(checked: boolean) {
    setUseDefaults(checked);
    if (checked) commitOptions({ ...defaults });
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
  // Destination preview (directory + file name), derived in one place — see view.ts.
  const { dir: destDir, name: target } = outputPreview(job, opts);
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
          <label style={S.defaultsToggle}>
            <input
              type="checkbox"
              checked={useDefaults}
              disabled={!editable}
              onChange={(e) => toggleUseDefaults(e.target.checked)}
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
        {/* The destination checkpoint above Create. "Where" (directory) and "what
            name" (file name) are still separate concerns here, so they are shown as
            two labeled lines, never joined into one finalized path. */}
        <div style={S.dest}>
          <span style={S.destLead}>{job.state === "done" ? "Saved" : "Will save"}</span>
          <div style={S.destRow}>
            <span style={S.destKey}>in</span>
            <span style={S.destVal} title={destDir}>
              {destDir}
            </span>
          </div>
          <div style={S.destRow}>
            <span style={S.destKey}>as</span>
            <span style={S.destVal} title={target}>
              {target}
            </span>
          </div>
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
        <ProgressLog events={jobEvents} />
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
    // gridTemplateColumns AND padding are set inline from the layout/constants
    // (so the body padding matches BODY_PADDING in the derived window minimum);
    // the splitter tracks provide the inter-pane spacing, so there is no grid gap.
    gap: 0,
  },
  listBody: { display: "flex", padding: "0.5rem", overflow: "hidden" },
  progressBody: { display: "flex", flexDirection: "column", padding: "0.6rem", overflow: "hidden" },
  muted: { color: "var(--text-2)", margin: "0.4rem 0" },
  // The destination checkpoint above Create: a "Will save" lead, then "in <dir>"
  // and "as <name>" on their own lines so where and what-name read as the two
  // separate concerns they still are. Plain text (no box); values selectable and
  // wrapping so the whole path/name is always visible.
  dest: { display: "grid", gap: "0.25rem", margin: "0.85rem 0 0.25rem", userSelect: "text" },
  destLead: { color: "var(--text-2)", fontSize: "0.85rem" },
  destRow: { display: "flex", gap: "0.6rem", alignItems: "baseline", minWidth: 0 },
  destKey: { color: "var(--text-2)", fontSize: "0.85rem", width: "1.75rem", flexShrink: 0, textAlign: "right" },
  destVal: { flex: 1, minWidth: 0, fontSize: "0.95rem", fontWeight: 600, wordBreak: "break-all" },
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
  defaultsToggle: { display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.85rem" },
};
