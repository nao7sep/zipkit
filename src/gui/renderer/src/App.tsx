/**
 * The queue screen: a list of jobs on the left, the selected job's detail on the
 * right. Add jobs (planned in the background), tune each job's options and intent,
 * then Start to drain the ready jobs one write at a time. Everything shown is a
 * field the SDK returned, surfaced through the main-process queue; the view
 * sequences queue commands and renders, it computes no archive logic.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ExtractData, Finding, Job, JobIntent, LogEvent, PlanData } from "../../shared/api";
import { DEFAULT_OPTIONS, type GuiOptions } from "../../shared/spec";
import { useConfirm } from "./components/DialogHost";
import { JobListbox } from "./components/JobListbox";
import { StateBadge } from "./components/StateBadge";
import {
  COLOR,
  droppedEntries,
  formatEventLine,
  isEditable,
  isTerminal,
  label,
  manifestRequiredButMissing,
  severityColor,
  verdictHeadline,
  verifySummary,
} from "./view";

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<GuiOptions>(DEFAULT_OPTIONS);
  const [events, setEvents] = useState<LogEvent[]>([]);

  useEffect(() => {
    const unsubscribe = window.zipkit.onQueue(setJobs);
    void window.zipkit.getQueue().then(setJobs); // initial list (incl. restored jobs)
    return unsubscribe;
  }, []);
  useEffect(
    () => window.zipkit.onEvent((e) => setEvents((prev) => [...prev.slice(-299), e])),
    [],
  );

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const anyReady = jobs.some((j) => j.state === "ready");

  async function addJob() {
    const inputs = await window.zipkit.chooseInputs();
    if (inputs.length === 0) return;
    const id = await window.zipkit.addJob(inputs, defaults, "save");
    setSelectedId(id);
  }

  return (
    <main style={S.main}>
      <header style={S.row}>
        <h1 style={{ margin: 0 }}>ZipKit</h1>
        <button onClick={() => void addJob()}>Add job…</button>
        <button onClick={() => void window.zipkit.startQueue()} disabled={!anyReady}>
          Start
        </button>
      </header>

      <details>
        <summary>Defaults for new jobs</summary>
        <OptionsPanel options={defaults} onChange={setDefaults} disabled={false} />
      </details>

      <div style={S.columns}>
        <JobListbox
          jobs={jobs}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRemove={(id) => void window.zipkit.removeJob(id)}
          onCancel={(id) => void window.zipkit.cancelJob(id)}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {selected ? <JobDetail job={selected} /> : <p style={{ opacity: 0.6 }}>Add a job to begin.</p>}
        </div>
      </div>

      <EventLog events={events} />
    </main>
  );
}

function JobDetail({ job }: { job: Job }) {
  const confirm = useConfirm();
  const [opts, setOpts] = useState<GuiOptions>(job.options);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [verify, setVerify] = useState<ExtractData | null>(null);
  const jobIdRef = useRef(job.id);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-sync local options only when a different job is selected (not when this
  // job's own options round-trip back through the queue update).
  useEffect(() => {
    if (jobIdRef.current !== job.id) {
      jobIdRef.current = job.id;
      setOpts(job.options);
      setVerify(null);
    }
  }, [job.id, job.options]);

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

  return (
    <section>
      <div style={S.row}>
        <StateBadge state={job.state} />
        <strong style={S.ellipsis}>{label(job)}</strong>
      </div>
      {job.message && <p style={{ opacity: 0.8 }}>{job.message}</p>}

      <label>
        Intent{" "}
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

      {!terminal && <OptionsPanel options={opts} onChange={changeOptions} disabled={!editable} />}

      {plan && !terminal && (
        <>
          <h3 style={{ color: plan.writable ? COLOR.ok : COLOR.bad, margin: "0.5rem 0" }}>
            {verdictHeadline(plan)}
          </h3>
          <p style={{ opacity: 0.8 }}>
            → <code>{plan.output}</code> — {plan.summary.included} included, {plan.summary.excluded}{" "}
            dropped, {plan.summary.warnings} warning(s), {plan.summary.errors} blocking
          </p>
          <FindingsList findings={plan.findings} />
          <Dropped plan={plan} />
        </>
      )}

      {job.state === "done" && job.intent === "save" && job.output && (
        <p>
          <button onClick={() => void window.zipkit.verify(job.output!, job.options.metadata).then((r) => r.ok && setVerify(r.data))}>
            Verify
          </button>
        </p>
      )}
      {verify && <VerifyView data={verify} />}
    </section>
  );
}

function OptionsPanel({
  options,
  onChange,
  disabled,
}: {
  options: GuiOptions;
  onChange: (o: GuiOptions) => void;
  disabled: boolean;
}) {
  const set = <K extends keyof GuiOptions>(key: K, value: GuiOptions[K]) =>
    onChange({ ...options, [key]: value });
  return (
    <fieldset disabled={disabled} style={S.fieldset}>
      <legend>Options</legend>
      <label><input type="checkbox" checked={options.junk} onChange={(e) => set("junk", e.target.checked)} /> Drop OS junk</label>
      <label><input type="checkbox" checked={options.strict} onChange={(e) => set("strict", e.target.checked)} /> Strict (block instead of fix)</label>
      <label><input type="checkbox" checked={options.metadata} onChange={(e) => set("metadata", e.target.checked)} /> Embed manifest</label>
      <label><input type="checkbox" checked={options.hash} disabled={!options.metadata} onChange={(e) => set("hash", e.target.checked)} /> Per-file SHA-256</label>
      <label>Compression <input type="number" min={1} max={9} value={options.level} onChange={(e) => set("level", Number(e.target.value))} style={{ width: "3rem" }} /></label>
      <label>Symlinks{" "}
        <select value={options.symlinks} onChange={(e) => set("symlinks", e.target.value as GuiOptions["symlinks"])}>
          <option value="ignore">ignore</option><option value="preserve">preserve</option><option value="follow">follow</option>
        </select>
      </label>
      <label>Empty dirs{" "}
        <select value={options.emptyDirs} onChange={(e) => set("emptyDirs", e.target.value as GuiOptions["emptyDirs"])}>
          <option value="keep">keep</option><option value="prune">prune</option>
        </select>
      </label>
      <label>Output <input type="text" placeholder="(beside the input)" value={options.output} onChange={(e) => set("output", e.target.value)} /></label>
      <label><input type="checkbox" checked={options.overwrite} onChange={(e) => set("overwrite", e.target.checked)} /> Overwrite existing</label>
      <label>Comment <input type="text" value={options.comment} onChange={(e) => set("comment", e.target.value)} /></label>
    </fieldset>
  );
}

function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <p style={{ opacity: 0.6 }}>No portability issues.</p>;
  return (
    <ul style={S.list}>
      {findings.map((f, i) => (
        <li key={i}>
          <code style={{ color: severityColor(f.severity) }}>{f.severity}</code> {f.rule} — {f.message}{" "}
          <small style={{ opacity: 0.6 }}>({f.path})</small>
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
            <code>{e.archivePath}</code> <small style={{ opacity: 0.6 }}>— {e.excludeReason ?? "excluded"}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}

function VerifyView({ data }: { data: ExtractData }) {
  const color = data.reportOk ? COLOR.ok : COLOR.bad;
  return (
    <section style={{ borderLeft: `3px solid ${color}`, paddingLeft: "0.75rem" }}>
      <strong style={{ color }}>{data.reportOk ? "Verified ✓" : "Verification failed"}</strong>{" "}
      — {verifySummary(data)}
      {data.missing.length > 0 && <div>Missing: {data.missing.join(", ")}</div>}
      {data.extra.length > 0 && <div>Extra: {data.extra.join(", ")}</div>}
    </section>
  );
}

function EventLog({ events }: { events: LogEvent[] }) {
  if (events.length === 0) return null;
  return (
    <details>
      <summary>Activity log ({events.length})</summary>
      <pre style={S.log}>{events.map(formatEventLine).join("\n")}</pre>
    </details>
  );
}

const S: Record<string, CSSProperties> = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1.25rem", color: "#eee", lineHeight: 1.5 },
  row: { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" },
  columns: { display: "flex", gap: "1rem", marginTop: "0.75rem", alignItems: "flex-start" },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fieldset: { display: "flex", gap: "1rem", flexWrap: "wrap", border: "1px solid #444", borderRadius: 6, margin: "0.75rem 0" },
  list: { margin: "0.25rem 0", paddingLeft: "1.25rem" },
  log: { background: "#111", padding: "0.5rem", borderRadius: 4, maxHeight: "12rem", overflow: "auto", fontSize: "0.8rem" },
};
