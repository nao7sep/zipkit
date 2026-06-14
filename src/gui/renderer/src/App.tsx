/**
 * The queue screen: a list of jobs on the left, the selected job's detail on the
 * right. Add jobs (planned in the background), tune each job's options and intent,
 * then Start to drain the ready jobs one write at a time. Everything shown is a
 * field the SDK returned, surfaced through the main-process queue; the view
 * sequences queue commands and renders, it computes no archive logic.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import type {
  ExtractData,
  Finding,
  Job,
  JobIntent,
  LogEvent,
  PlanData,
} from "../../shared/api";
import { DEFAULT_OPTIONS, type GuiOptions } from "../../shared/spec";
import { useConfirm } from "./components/DialogHost";

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
        <JobList jobs={jobs} selectedId={selectedId} onSelect={setSelectedId} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {selected ? <JobDetail job={selected} /> : <p style={{ opacity: 0.6 }}>Add a job to begin.</p>}
        </div>
      </div>

      <EventLog events={events} />
    </main>
  );
}

function JobList({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (jobs.length === 0) return <div style={S.listCol} />;
  return (
    <ul style={S.listCol}>
      {jobs.map((job) => (
        <li
          key={job.id}
          onClick={() => onSelect(job.id)}
          style={{ ...S.jobRow, ...(job.id === selectedId ? S.jobRowSel : null) }}
        >
          <StateBadge state={job.state} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.ellipsis}>{label(job)}</div>
            <small style={{ opacity: 0.6 }}>
              {job.intent === "archive-and-trash" ? "→ Trash" : "save"}
              {job.message ? ` · ${job.message}` : ""}
            </small>
          </div>
          {(job.state === "planning" || job.state === "running") && (
            <button onClick={(e) => stop(e, () => window.zipkit.cancelJob(job.id))}>Cancel</button>
          )}
          {job.state !== "running" && (
            <button onClick={(e) => stop(e, () => window.zipkit.removeJob(job.id))}>✕</button>
          )}
        </li>
      ))}
    </ul>
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

  const editable = job.state !== "running" && job.state !== "done";
  const terminal = job.state === "done" || job.state === "failed";

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
      {job.intent === "archive-and-trash" && !opts.metadata && (
        <p style={{ color: "#ffb74d" }}>Enable “Embed manifest” — verify-before-Trash needs it.</p>
      )}

      {!terminal && <OptionsPanel options={opts} onChange={changeOptions} disabled={!editable} />}

      {plan && !terminal && (
        <>
          <h3 style={{ color: plan.writable ? "#4caf50" : "#ff6b6b", margin: "0.5rem 0" }}>
            {plan.writable ? "Windows-safe ✓" : "Blocking issues"}
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
  const tier = (s: Finding["severity"]) => (s === "error" ? "#ff6b6b" : s === "warning" ? "#ffb74d" : "#9ccc65");
  return (
    <ul style={S.list}>
      {findings.map((f, i) => (
        <li key={i}>
          <code style={{ color: tier(f.severity) }}>{f.severity}</code> {f.rule} — {f.message}{" "}
          <small style={{ opacity: 0.6 }}>({f.path})</small>
        </li>
      ))}
    </ul>
  );
}

function Dropped({ plan }: { plan: PlanData }) {
  const dropped = plan.entries.filter((e) => e.excluded);
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
  return (
    <section style={{ borderLeft: `3px solid ${data.reportOk ? "#4caf50" : "#ff6b6b"}`, paddingLeft: "0.75rem" }}>
      <strong style={{ color: data.reportOk ? "#4caf50" : "#ff6b6b" }}>
        {data.reportOk ? "Verified ✓" : "Verification failed"}
      </strong>{" "}
      — {data.summary.total} entries, {data.summary.crcFailed} CRC failure(s), {data.summary.shaMismatched} SHA mismatch(es)
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
      <pre style={S.log}>{events.map((e) => `${e.time}  ${e.level}  ${e.message}`).join("\n")}</pre>
    </details>
  );
}

function StateBadge({ state }: { state: Job["state"] }) {
  const color: Record<Job["state"], string> = {
    planning: "#888",
    "needs-attention": "#ffb74d",
    ready: "#42a5f5",
    running: "#ffee58",
    done: "#4caf50",
    failed: "#ff6b6b",
  };
  return (
    <span style={{ color: color[state], fontWeight: 600, fontSize: "0.8rem", whiteSpace: "nowrap" }}>
      ● {state}
    </span>
  );
}

function label(job: Job): string {
  const first = job.inputs[0] ?? "(no input)";
  const base = first.split("/").pop() || first;
  return job.inputs.length > 1 ? `${base} +${job.inputs.length - 1}` : base;
}

function stop(e: MouseEvent, fn: () => void): void {
  e.stopPropagation();
  fn();
}

const S: Record<string, CSSProperties> = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1.25rem", color: "#eee", lineHeight: 1.5 },
  row: { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" },
  columns: { display: "flex", gap: "1rem", marginTop: "0.75rem", alignItems: "flex-start" },
  listCol: { width: "18rem", flexShrink: 0, margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "0.25rem" },
  jobRow: { display: "flex", gap: "0.5rem", alignItems: "center", padding: "0.5rem", border: "1px solid #333", borderRadius: 6, cursor: "pointer" },
  jobRowSel: { borderColor: "#42a5f5", background: "#1e2a35" },
  ellipsis: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fieldset: { display: "flex", gap: "1rem", flexWrap: "wrap", border: "1px solid #444", borderRadius: 6, margin: "0.75rem 0" },
  list: { margin: "0.25rem 0", paddingLeft: "1.25rem" },
  log: { background: "#111", padding: "0.5rem", borderRadius: 4, maxHeight: "12rem", overflow: "auto", fontSize: "0.8rem" },
};
