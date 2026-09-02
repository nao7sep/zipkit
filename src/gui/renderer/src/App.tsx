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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { GuiLogEvent, Job, JobIntent, PlanData, VerifyResult } from "../../shared/api";
import { DEFAULT_OPTIONS, optionsEqual, type GuiOptions, type GuiSettings } from "../../shared/spec";
import {
  ARCHIVE_MIN_WIDTH,
  BODY_MIN_HEIGHT,
  BODY_PADDING,
  DEFAULT_LAYOUT,
  LAYOUT_BOUNDS,
  SPLITTER_WIDTH,
  clampLayout,
  clampLayoutToWidth,
  type PaneLayout,
} from "../../shared/layout";
import { AboutDialog } from "./components/AboutDialog";
import { AppLoadGate } from "./components/AppLoadGate";
import { AppHeader } from "./components/AppHeader";
import { CommandBar } from "./components/CommandBar";
import { isComposing } from "./composition";
import {
  denyUnhandledExternalDrop,
  droppedFileOperationKey,
  inspectExternalFileOffer,
  receiverOperationKey,
  reportableError,
  settleReceiverResult,
  type ReceiverCommit,
  type ReceiverOutcome,
  type ReceiverResult,
  resolveDroppedFiles,
  summarizeDroppedFiles,
} from "./externalDropBoundary";
import { planInputAdmission } from "./inputAdmission";
import { hasMod, isEditableTarget, shadowsMacTextBinding } from "./shortcuts";
import { useConfirm, type ConfirmOptions } from "./components/DialogHost";
import { InputList } from "./components/InputList";
import { JobListbox } from "./components/JobListbox";
import { LayoutPersistenceNotice } from "./components/LayoutPersistenceNotice";
import { OptionsPanel } from "./components/OptionsPanel";
import { Pane } from "./components/Pane";
import { ProgressLog } from "./components/ProgressLog";
import { ReceiverResultNotice } from "./components/ReceiverResultNotice";
import { Report } from "./components/Report";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Splitter } from "./components/Splitter";
import { StateBadge } from "./components/StateBadge";
import {
  archiveName,
  COLOR,
  isEditable,
  jobCommands,
  type JobCommand,
  label,
  manifestRequiredButMissing,
  outputPreview,
} from "./view";

type DialogName = "settings" | "shortcuts" | "about";

const GROW: CSSProperties = { flex: 1 };

/** The confirmation a run needs, or null when it needs none (the confirmation
 *  policy). Only an `archive-and-trash` run is destructive — it writes, verifies,
 *  then moves the originals to the Trash, and the "Create archive" button does not
 *  say so. Shared by the button path (JobView) and the keyboard accelerator (App)
 *  so both honor the same policy. A plain `save` run moves nothing and needs no
 *  confirm. */
function runConfirmation(job: Job): ConfirmOptions | null {
  if (job.intent !== "archive-and-trash") return null;
  const n = job.inputs.length;
  return {
    title: "Create archive and move originals to Trash?",
    message: `The archive will be created and verified, then the ${n} original ${
      n === 1 ? "item" : "items"
    } will be moved to the Trash. The originals are moved only after the archive verifies.`,
    confirmLabel: "Create and move to Trash",
    danger: true,
  };
}

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<GuiOptions>(DEFAULT_OPTIONS);
  // The UI (chrome) font family. Blank = the built-in default stack (the index.css --font-ui var).
  const [uiFontFamily, setUiFontFamily] = useState<string>("");
  const [events, setEvents] = useState<GuiLogEvent[]>([]);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  // A one-shot request to move keyboard focus to a job's row once it renders, set
  // when Add creates a job (focus/selection policy: Add pulls focus to its result).
  // The listbox clears it via onFocusPulled once the focus lands. The clear is
  // stable (useCallback) so the listbox's focus effect re-runs only on real changes.
  const [pullFocusId, setPullFocusId] = useState<string | null>(null);
  const clearPullFocus = useCallback(() => setPullFocusId(null), []);
  // App-level confirm for the run accelerator (the button path uses JobView's).
  const confirm = useConfirm();
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
  const [jobsDropActive, setJobsDropActive] = useState(false);
  const [jobsResult, setJobsResult] = useState<ReceiverResult | null>(null);
  const [inputResults, setInputResults] = useState<Record<string, ReceiverResult>>({});
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [layoutSaveFailed, setLayoutSaveFailed] = useState(false);
  const layoutSaveAttempt = useRef(0);
  const layoutSaveChain = useRef<Promise<void>>(Promise.resolve());

  const clearJobsDrop = useCallback(() => {
    setJobsDropActive(false);
  }, []);

  useEffect(() => {
    let live = true;
    let loaded = false;
    let latestQueue: Job[] | null = null;
    let unsubscribe = () => {};

    try {
      // Subscribe before the snapshot read so an update that lands during
      // hydration cannot be overwritten by an older getQueue response.
      unsubscribe = window.zipkit.onQueue((next) => {
        latestQueue = next;
        if (live && loaded) setJobs(next);
      });
    } catch (error) {
      window.zipkit.reportError("subscribe to queue during app load", reportableError(error));
      setLoadState("failed");
      return () => {
        live = false;
      };
    }

    void Promise.all([
      window.zipkit.getQueue(),
      window.zipkit.getSettings(),
      window.zipkit.getLayout(),
    ]).then(([initialJobs, settings, layout]) => {
      if (!live) return;
      loaded = true;
      setJobs(latestQueue ?? initialJobs);
      setDefaults(settings.defaults);
      setUiFontFamily(settings.uiFontFamily);
      // Persisted pane widths are the intent. Live-width clamping below affects
      // display only and never rewrites what the user dragged.
      setIntent(clampLayout(layout));
      setLoadState("ready");
    }).catch((error) => {
      if (!live) return;
      window.zipkit.reportError("load required application state", reportableError(error));
      setLoadState("failed");
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, [loadAttempt]);

  // Apply the configured UI font by overriding the `--font-ui` CSS variable on :root; blank reverts
  // to the index.css default. The string is handed to CSS verbatim (system fonts only — the CSP
  // forbids web fonts); the read-only mono log/report keep their own --font-mono.
  useEffect(() => {
    const family = uiFontFamily.trim();
    const root = document.documentElement;
    if (family) root.style.setProperty("--font-ui", family);
    else root.style.removeProperty("--font-ui");
  }, [uiFontFamily]);

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
  }, [loadState]);
  useEffect(
    () => window.zipkit.onEvent((e) => setEvents((prev) => [...prev.slice(-999), e])),
    [],
  );

  useEffect(() => {
    window.addEventListener("blur", clearJobsDrop);
    window.addEventListener("dragend", clearJobsDrop);
    return () => {
      window.removeEventListener("blur", clearJobsDrop);
      window.removeEventListener("dragend", clearJobsDrop);
    };
  }, [clearJobsDrop]);

  // Block the renderer's default drop behavior window-wide: without this, a file
  // dropped outside Jobs or Inputs can navigate Chromium to a file:// URL and
  // replace the app. Owned receivers consume their events first; this boundary is
  // silent and never turns dead space into another operation.
  useEffect(() => {
    window.addEventListener("dragover", denyUnhandledExternalDrop);
    window.addEventListener("drop", denyUnhandledExternalDrop);
    return () => {
      window.removeEventListener("dragover", denyUnhandledExternalDrop);
      window.removeEventListener("drop", denyUnhandledExternalDrop);
    };
  }, []);

  // App-level accelerators (all Cmd/Ctrl combos; the plain navigation/edit keys
  // belong to the listbox and the fields): N adds a job, Enter creates the selected
  // job's archive, Comma opens Settings, Question opens Shortcuts. Kept in step with
  // the catalog the Shortcuts dialog renders (shortcuts.ts). Suppressed while any
  // modal is open and inert during IME composition (text-input-and-IME conventions).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isComposing(e)) return;
      if (!hasMod(e)) return;
      if (document.querySelector("[data-app-load-gate]")) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (
        isEditableTarget(e.target) &&
        shadowsMacTextBinding(e, /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent))
      ) {
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        setDialog("settings");
      } else if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        setDialog("shortcuts");
      } else if (e.key === "Enter") {
        e.preventDefault();
        void runSelectedRef.current();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        void addJobRef.current();
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
  async function saveSettings(next: GuiSettings): Promise<void> {
    await window.zipkit.setSettings(next);
    setDefaults(next.defaults);
    setUiFontFamily(next.uiFontFamily);
  }

  async function createJob(inputs: string[]): Promise<ReceiverCommit> {
    const admission = planInputAdmission([], inputs);
    if (admission.accepted.length === 0) return { changed: false, accepted: 0, result: null };
    try {
      const id = await window.zipkit.addJob(admission.accepted, defaults, "save");
      setSelectedId(id);
      setPullFocusId(id); // focus the new row once it renders (focus/selection policy)
      return {
        changed: true,
        accepted: admission.accepted.length,
        result: admission.duplicates > 0
          ? {
              message: `Created the job with ${admission.accepted.length} ${admission.accepted.length === 1 ? "input" : "inputs"}; ${admission.duplicates} ${admission.duplicates === 1 ? "duplicate input was" : "duplicate inputs were"} already included.`,
              severity: "information",
            }
          : null,
      };
    } catch (error) {
      window.zipkit.reportError("create job", reportableError(error));
      return {
        changed: false,
        accepted: 0,
        result: { message: "The job could not be created. Check that the inputs are still available, then try again.", severity: "error" },
      };
    }
  }

  async function addJob() {
    try {
      const inputs = await window.zipkit.chooseInputs();
      if (inputs.length === 0) return;
      const outcome = {
        operationKey: receiverOperationKey("jobs", inputs),
        entryKey: "jobs:picker",
        result: (await createJob(inputs)).result,
      };
      setJobsResult((current) => settleReceiverResult(current, outcome));
    } catch (error) {
      window.zipkit.reportError("choose new-job inputs", reportableError(error));
      setJobsResult((current) => settleReceiverResult(current, {
        operationKey: "jobs:picker",
        entryKey: "jobs:picker",
        result: { message: "The input picker could not be opened. Try again.", severity: "error" },
      }));
    }
  }

  function onJobsDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (inspectExternalFileOffer(event.dataTransfer) === "rejected" || dialog !== null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setJobsDropActive(true);
  }

  async function onJobsDrop(event: React.DragEvent<HTMLDivElement>) {
    const offer = inspectExternalFileOffer(event.dataTransfer);
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "none";
    clearJobsDrop();
    if (dialog !== null) return;
    if (offer === "rejected") {
      setJobsResult((current) => settleReceiverResult(current, {
        operationKey: "jobs:unsupported-drop",
        entryKey: "jobs:drop",
        result: {
          message: "Drop files or folders on Jobs to create a new archive job.",
          severity: "warning",
        },
      }));
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    const operationKey = files.length > 0
      ? droppedFileOperationKey("jobs", files)
      : "jobs:drop";
    const resolved = resolveDroppedFiles(files, window.zipkit.pathForFile);
    for (const error of resolved.errors) {
      window.zipkit.reportError("resolve dropped new-job input", error);
    }
    if (resolved.paths.length === 0) {
      setJobsResult((current) => settleReceiverResult(current, {
        operationKey,
        entryKey: "jobs:drop",
        result: {
          message: "The dropped items could not be accessed as local files or folders.",
          severity: resolved.errors.length > 0 ? "error" : "warning",
        },
      }));
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    const commit = await createJob(resolved.paths);
    const result = summarizeDroppedFiles("Created the job with", resolved, commit);
    setJobsResult((current) => settleReceiverResult(current, {
      operationKey,
      entryKey: "jobs:drop",
      result,
    }));
  }

  // The keyboard accelerator for "create the selected job's archive". Mirrors the
  // command bar's Create / Try again: it acts only when the selection actually
  // offers that command, and goes through the same run confirmation, so the
  // accelerator can never bypass the confirmation policy. Blur first, so a
  // commit-on-blur field (the file name) lands its value before the run re-plans.
  async function runSelected() {
    if (!selected) return;
    const cmds = jobCommands(selected);
    if (!cmds.includes("create") && !cmds.includes("retry")) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const ask = runConfirmation(selected);
    if (ask && !(await confirm(ask))) return;
    void window.zipkit.runJob(selected.id);
  }

  // Latest-ref so the window-level key handler (subscribed once) always invokes the
  // current closures — fresh defaults for Add, fresh selection for Create — without
  // re-subscribing the listener on every render.
  const addJobRef = useRef(addJob);
  addJobRef.current = addJob;
  const runSelectedRef = useRef(runSelected);
  runSelectedRef.current = runSelected;

  // The persisted value is the INTENT — and persistence happens ONLY here, in the
  // drag-release handler, never on a window resize.
  async function persistLayout(layout: PaneLayout): Promise<void> {
    const attempt = ++layoutSaveAttempt.current;
    // Keep durable writes in gesture order. A rapid keyboard resize may enqueue
    // another intent before the previous disk write finishes; serializing here
    // ensures the newest successful intent is also the bytes left on disk.
    const save = layoutSaveChain.current
      .catch(() => {})
      .then(() => window.zipkit.setLayout(layout));
    layoutSaveChain.current = save;
    try {
      await save;
      if (layoutSaveAttempt.current === attempt) setLayoutSaveFailed(false);
    } catch {
      // Main owns and logs the full error. The renderer owns only the concise,
      // persistent consequence beside the panes; the in-memory layout stays put.
      if (layoutSaveAttempt.current === attempt) setLayoutSaveFailed(true);
    }
  }
  // The Jobs|Archive handle: drag right widens Jobs. The Archive|Progress handle
  // (rendered inside the middle column) drags right to widen Archive (narrow
  // Progress). A drag sets the user's intent (clamped only into the per-column
  // bounds — the live width-aware clamp is applied for DISPLAY, not stored), and
  // persists it on release.
  const jobsSplitter = (
    <Splitter
      label="Resize Jobs pane"
      value={intent.jobsWidth}
      min={LAYOUT_BOUNDS.jobsWidth.min}
      max={LAYOUT_BOUNDS.jobsWidth.max}
      onDragStart={() => (dragBase.current = intentRef.current)}
      onDragDelta={(dx) =>
        setIntent(clampLayout({ ...dragBase.current, jobsWidth: dragBase.current.jobsWidth + dx }))
      }
      onDragEnd={() => void persistLayout(intentRef.current)}
      onDragCancel={() => setIntent(dragBase.current)}
      onKeyboardDelta={(dx) => {
        const next = clampLayout({ ...intentRef.current, jobsWidth: intentRef.current.jobsWidth + dx });
        setIntent(next);
        void persistLayout(next);
      }}
    />
  );
  const progressSplitter = (
    <Splitter
      label="Resize Progress pane"
      value={intent.progressWidth}
      min={LAYOUT_BOUNDS.progressWidth.min}
      max={LAYOUT_BOUNDS.progressWidth.max}
      direction={-1}
      onDragStart={() => (dragBase.current = intentRef.current)}
      onDragDelta={(dx) =>
        setIntent(
          clampLayout({ ...dragBase.current, progressWidth: dragBase.current.progressWidth - dx }),
        )
      }
      onDragEnd={() => void persistLayout(intentRef.current)}
      onDragCancel={() => setIntent(dragBase.current)}
      onKeyboardDelta={(dx) => {
        const next = clampLayout({ ...intentRef.current, progressWidth: intentRef.current.progressWidth - dx });
        setIntent(next);
        void persistLayout(next);
      }}
    />
  );

  // The DISPLAYED widths fed to the grid: the intent clamped to the live body
  // width, so a window-shrink narrows the panes toward their minimums while a
  // window-grow returns them to the intent. Display-only — never persisted.
  const displayed = useMemo(
    () => clampLayoutToWidth(intent, containerWidth),
    [intent, containerWidth],
  );

  if (loadState !== "ready") {
    return (
      <AppLoadGate
        failed={loadState === "failed"}
        onRetry={() => {
          setLoadState("loading");
          setLoadAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

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
      {layoutSaveFailed && (
        <LayoutPersistenceNotice onDismiss={() => setLayoutSaveFailed(false)} />
      )}
      <div data-app-content-viewport style={S.contentViewport}>
        <div data-app-pane-grid ref={bodyRef} style={bodyStyle}>
        <Pane
          title="Jobs"
          actions={
            <button className="accent" onClick={() => void addJob()}>
              Add
            </button>
          }
          bodyStyle={S.listBody}
          rootStyle={GROW}
        >
          <div
            data-drop-receiver="jobs"
            style={{ ...S.jobsReceiver, ...(jobsDropActive ? S.jobsReceiverActive : null) }}
            onDragOver={onJobsDragOver}
            onDragLeave={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !event.currentTarget.contains(next)) clearJobsDrop();
            }}
            onDrop={(event) => void onJobsDrop(event)}
          >
            <JobListbox
              jobs={jobsNewestFirst}
              selectedId={selectedId}
              pullFocusId={pullFocusId}
              onFocusPulled={clearPullFocus}
              onSelect={setSelectedId}
              onRemove={(id) => void window.zipkit.removeJob(id)}
              onCancel={(id) => void window.zipkit.cancelJob(id)}
            />
            {jobsResult && (
              <ReceiverResultNotice result={jobsResult} onDismiss={() => setJobsResult(null)} />
            )}
          </div>
        </Pane>

        {jobsSplitter}

        {selected ? (
          <JobView
            key={selected.id}
            job={selected}
            defaults={defaults}
            events={events}
            splitter={progressSplitter}
            inputResult={inputResults[selected.id] ?? null}
            onInputResult={(outcome) =>
              setInputResults((current) => {
                const result = settleReceiverResult(current[selected.id] ?? null, outcome);
                if (result !== null) return { ...current, [selected.id]: result };
                const next = { ...current };
                delete next[selected.id];
                return next;
              })
            }
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
      </div>

      {dialog === "settings" && (
        <SettingsDialog
          settings={{ defaults, uiFontFamily }}
          onSave={saveSettings}
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
  inputResult,
  onInputResult,
}: {
  job: Job;
  defaults: GuiOptions;
  events: GuiLogEvent[];
  splitter: ReactNode;
  inputResult: ReceiverResult | null;
  onInputResult: (outcome: ReceiverOutcome) => void;
}) {
  // Keyed by job id in the parent, so this remounts per job: local option draft and
  // verify state start fresh, no manual re-sync.
  const [opts, setOpts] = useState<GuiOptions>(job.options);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
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
  async function addPaths(paths: string[]): Promise<ReceiverCommit> {
    const admission = planInputAdmission(job.inputs, paths);
    if (admission.accepted.length === 0) {
      return {
        changed: false,
        accepted: 0,
        result: admission.duplicates > 0
          ? {
              message: `${admission.duplicates === 1 ? "That input is" : "Those inputs are"} already in this job.`,
              severity: "information",
            }
          : null,
      };
    }
    try {
      await window.zipkit.updateJob(job.id, { inputs: [...job.inputs, ...admission.accepted] });
    } catch (error) {
      window.zipkit.reportError("add inputs to job", reportableError(error));
      return {
        changed: false,
        accepted: 0,
        result: { message: "Inputs could not be added. Check that they are still available, then try again.", severity: "error" },
      };
    }
    return {
      changed: true,
      accepted: admission.accepted.length,
      result: admission.duplicates > 0
        ? {
            message: `Added ${admission.accepted.length} new ${admission.accepted.length === 1 ? "input" : "inputs"}; ${admission.duplicates} ${admission.duplicates === 1 ? "input was" : "inputs were"} already in this job.`,
            severity: "information",
          }
        : null,
    };
  }
  async function addInputs(): Promise<ReceiverOutcome | null> {
    const paths = await window.zipkit.chooseInputs();
    if (paths.length === 0) return null;
    return {
      operationKey: receiverOperationKey(`inputs:${job.id}`, paths),
      entryKey: `inputs:${job.id}:picker`,
      result: (await addPaths(paths)).result,
    };
  }
  async function onDropFiles(files: File[]): Promise<ReceiverOutcome> {
    const resolved = resolveDroppedFiles(files, window.zipkit.pathForFile);
    const entryKey = `inputs:${job.id}:drop`;
    const operationKey = files.length > 0
      ? droppedFileOperationKey(`inputs:${job.id}`, files)
      : entryKey;
    for (const error of resolved.errors) {
      window.zipkit.reportError("resolve dropped existing-job input", error);
    }
    if (resolved.paths.length === 0) {
      return {
        operationKey,
        entryKey,
        result: {
          message: "The dropped items could not be accessed as local files or folders.",
          severity: resolved.errors.length > 0 ? "error" : "warning",
        },
      };
    }
    const commit = await addPaths(resolved.paths);
    return {
      operationKey,
      entryKey,
      result: summarizeDroppedFiles("Added", resolved, commit),
    };
  }
  function removeInput(path: string) {
    if (job.inputs.length <= 1) return; // a job must archive something
    void window.zipkit.updateJob(job.id, { inputs: job.inputs.filter((p) => p !== path) });
  }

  async function onCommand(c: JobCommand) {
    switch (c) {
      case "create":
      case "retry": {
        // Confirm only when running this job also moves the user's data (the
        // confirmation policy) — runConfirmation returns the prompt for an
        // archive-and-trash run and null for a plain save.
        const ask = runConfirmation(job);
        if (ask && !(await confirm(ask))) break;
        void window.zipkit.runJob(job.id);
        break;
      }
      case "cancel":
        void window.zipkit.cancelJob(job.id);
        break;
      case "verify":
        if (job.output)
          void window.zipkit
            .verify(job.id, job.output, job.options.metadata)
            .then(setVerify);
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
        // Deletes the user's archive (to the Trash), so confirm explicitly. The
        // inputs are untouched, so the job stays and can create the archive again.
        if (
          await confirm({
            title: "Move this archive to the Trash?",
            message:
              "The archive file for this job will be moved to the Trash. Your original files and directories are kept, so you can create the archive again.",
            confirmLabel: "Move to Trash",
            danger: true,
          })
        )
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
          onAdd={addInputs}
          onRemove={removeInput}
          onDropFiles={onDropFiles}
          result={inputResult}
          onResult={onInputResult}
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
  contentViewport: { flex: 1, minHeight: 0, overflow: "auto" },
  body: {
    height: "100%",
    minHeight: BODY_MIN_HEIGHT,
    display: "grid",
    // gridTemplateColumns AND padding are set inline from the layout/constants
    // (so the body padding matches BODY_PADDING in the derived window minimum);
    // the splitter tracks provide the inter-pane spacing, so there is no grid gap.
    gap: 0,
  },
  listBody: { display: "flex", flexDirection: "column", padding: "0.5rem", overflow: "hidden" },
  progressBody: { display: "flex", flexDirection: "column", padding: "0.6rem", overflow: "hidden" },
  muted: { color: "var(--text-2)", margin: "0.4rem 0" },
  jobsReceiver: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    borderRadius: 6,
  },
  jobsReceiverActive: {
    boxShadow: "0 0 0 2px var(--accent)",
    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
  },
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
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
  },
  defaultsToggle: { display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.85rem" },
};
