/**
 * The single-job screen. Pick inputs, adjust options (re-plans live), inspect the
 * verdict + findings + what's dropped, then either Save, or "Archive & move
 * originals to Trash" (a gated, all-or-nothing write -> verify -> trash, behind a
 * confirm dialog), or Verify a written archive on demand. Everything shown is a
 * field the SDK returned; the view sequences verbs and renders, it computes no
 * archive logic.
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ArchiveAndTrashResult,
  ExtractData,
  Finding,
  GuiError,
  LogEvent,
  PlanData,
  WriteData,
} from "../../shared/api";
import { buildSpec, DEFAULT_OPTIONS, type GuiOptions } from "../../shared/spec";
import { useConfirm } from "./components/DialogHost";

type Status = "idle" | "planning" | "writing";

export function App() {
  const confirm = useConfirm();
  const [inputs, setInputs] = useState<string[]>([]);
  const [options, setOptions] = useState<GuiOptions>(DEFAULT_OPTIONS);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [error, setError] = useState<GuiError | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<WriteData | null>(null);
  const [verify, setVerify] = useState<ExtractData | null>(null);
  const [trash, setTrash] = useState<ArchiveAndTrashResult | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);

  useEffect(() => window.zipkit.onEvent((e) => setEvents((prev) => [...prev, e])), []);

  // Live, debounced re-plan whenever the inputs or options change.
  useEffect(() => {
    if (inputs.length === 0) {
      setPlan(null);
      setError(null);
      return;
    }
    const handle = setTimeout(() => {
      void (async () => {
        setStatus("planning");
        resetOutputs();
        const res = await window.zipkit.plan(buildSpec(inputs, options));
        setStatus("idle");
        if (res.ok) {
          setPlan(res.plan);
          setError(null);
        } else {
          setPlan(null);
          setError(res.error);
        }
      })();
    }, 250);
    return () => clearTimeout(handle);
  }, [inputs, options]);

  function resetOutputs() {
    setEvents([]);
    setResult(null);
    setVerify(null);
    setTrash(null);
  }

  async function pickInputs() {
    const chosen = await window.zipkit.chooseInputs();
    if (chosen.length > 0) setInputs(chosen);
  }

  async function save() {
    setStatus("writing");
    resetOutputs();
    const res = await window.zipkit.write();
    setStatus("idle");
    if (res.ok) setResult(res.data);
    else setError(res.error);
  }

  async function runVerify(archive: string, checkMetadata: boolean) {
    const res = await window.zipkit.verify(archive, checkMetadata);
    if (res.ok) setVerify(res.data);
    else setError(res.error);
  }

  async function archiveAndTrash() {
    const ok = await confirm({
      title: "Move originals to Trash?",
      message: `After the archive is written and verified, the ${inputs.length} selected item(s) will be moved to the Trash. They are kept if writing or verification fails.`,
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (!ok) return;
    setStatus("writing");
    resetOutputs();
    const res = await window.zipkit.archiveAndTrash();
    setStatus("idle");
    setTrash(res);
    if (res.ok) setInputs([]); // originals are gone; reset for the next job
  }

  const busy = status !== "idle";
  const canSave = plan?.writable === true && !busy;

  return (
    <main style={S.main}>
      <header style={S.row}>
        <h1 style={{ margin: 0 }}>ZipKit</h1>
        <button onClick={() => void pickInputs()} disabled={busy}>
          Choose folders or files…
        </button>
        {busy && <button onClick={() => void window.zipkit.cancel()}>Cancel</button>}
        <span style={{ opacity: 0.7 }}>
          {status === "planning" ? "Planning…" : status === "writing" ? "Working…" : ""}
        </span>
      </header>

      {inputs.length > 0 && <p style={{ opacity: 0.7 }}>{inputs.join("  ·  ")}</p>}

      <OptionsPanel options={options} onChange={setOptions} disabled={status === "writing"} />

      {error && (
        <p role="alert" style={{ color: "#ff6b6b" }}>
          {error.code}: {error.message}
        </p>
      )}

      {result && (
        <p style={{ color: "#4caf50" }}>
          Saved {result.output} ({result.bytes ?? 0} bytes{result.zip64 ? ", zip64" : ""}).{" "}
          <button onClick={() => void runVerify(result.output, options.metadata)}>Verify</button>
        </p>
      )}

      {verify && <VerifyView data={verify} />}
      {trash && <TrashView result={trash} />}

      {plan && (
        <section>
          <div style={S.row}>
            <h2 style={{ color: plan.writable ? "#4caf50" : "#ff6b6b", margin: "0.5rem 0" }}>
              {plan.writable ? "Windows-safe ✓" : "Blocking issues — resolve before saving"}
            </h2>
            <button onClick={() => void save()} disabled={!canSave}>
              Save archive
            </button>
            <button
              onClick={() => void archiveAndTrash()}
              disabled={!canSave || !options.metadata}
              title={!options.metadata ? "Embed the manifest to enable verify-before-delete" : undefined}
              style={canSave && options.metadata ? S.danger : undefined}
            >
              Archive & move originals to Trash
            </button>
          </div>
          <p style={{ opacity: 0.8 }}>
            → <code>{plan.output}</code> — {plan.summary.included} included, {plan.summary.excluded}{" "}
            dropped, {plan.summary.warnings} warning(s), {plan.summary.errors} blocking
          </p>
          <FindingsList findings={plan.findings} />
          <Dropped plan={plan} />
        </section>
      )}

      <EventLog events={events} />
    </main>
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
      <label>
        <input type="checkbox" checked={options.junk} onChange={(e) => set("junk", e.target.checked)} /> Drop OS junk
      </label>
      <label>
        <input type="checkbox" checked={options.strict} onChange={(e) => set("strict", e.target.checked)} /> Strict (block instead of fix)
      </label>
      <label>
        <input type="checkbox" checked={options.metadata} onChange={(e) => set("metadata", e.target.checked)} /> Embed manifest
      </label>
      <label>
        <input
          type="checkbox"
          checked={options.hash}
          disabled={!options.metadata}
          onChange={(e) => set("hash", e.target.checked)}
        /> Per-file SHA-256
      </label>
      <label>
        Compression{" "}
        <input
          type="number"
          min={1}
          max={9}
          value={options.level}
          onChange={(e) => set("level", Number(e.target.value))}
          style={{ width: "3rem" }}
        />
      </label>
      <label>
        Symlinks{" "}
        <select value={options.symlinks} onChange={(e) => set("symlinks", e.target.value as GuiOptions["symlinks"])}>
          <option value="ignore">ignore</option>
          <option value="preserve">preserve</option>
          <option value="follow">follow</option>
        </select>
      </label>
      <label>
        Empty dirs{" "}
        <select value={options.emptyDirs} onChange={(e) => set("emptyDirs", e.target.value as GuiOptions["emptyDirs"])}>
          <option value="keep">keep</option>
          <option value="prune">prune</option>
        </select>
      </label>
      <label>
        Output{" "}
        <input
          type="text"
          placeholder="(beside the input)"
          value={options.output}
          onChange={(e) => set("output", e.target.value)}
        />
      </label>
      <label>
        <input type="checkbox" checked={options.overwrite} onChange={(e) => set("overwrite", e.target.checked)} /> Overwrite existing
      </label>
      <label>
        Comment{" "}
        <input type="text" value={options.comment} onChange={(e) => set("comment", e.target.value)} />
      </label>
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
      — {data.summary.total} entries, {data.summary.crcFailed} CRC failure(s),{" "}
      {data.summary.shaMismatched} SHA mismatch(es)
      {data.missing.length > 0 && <div>Missing: {data.missing.join(", ")}</div>}
      {data.extra.length > 0 && <div>Extra: {data.extra.join(", ")}</div>}
    </section>
  );
}

function TrashView({ result }: { result: ArchiveAndTrashResult }) {
  if (result.ok) {
    return (
      <p style={{ color: "#4caf50" }}>
        Saved & verified {result.output} ({result.bytes ?? 0} bytes); moved {result.trashed.length} original(s) to Trash.
      </p>
    );
  }
  const messages: Record<typeof result.reason, string> = {
    "no-plan": "Nothing to archive.",
    "not-writable": "Resolve the blocking issues before archiving.",
    "unsafe-output": "The archive would be inside the source — choose an output outside it; originals untouched.",
    "write-failed": `Write failed (${result.error?.message ?? "unknown"}). Originals kept.`,
    "verify-failed": "Verification failed — originals kept.",
    "trash-failed": `Archive saved & verified${result.output ? ` at ${result.output}` : ""}, but moving some originals to Trash failed (${result.error?.message ?? "unknown"}).`,
  };
  return <p style={{ color: "#ff6b6b" }}>{messages[result.reason]}</p>;
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

const S: Record<string, CSSProperties> = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1.25rem", color: "#eee", lineHeight: 1.5 },
  row: { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" },
  fieldset: { display: "flex", gap: "1rem", flexWrap: "wrap", border: "1px solid #444", borderRadius: 6, margin: "0.75rem 0" },
  list: { margin: "0.25rem 0", paddingLeft: "1.25rem" },
  log: { background: "#111", padding: "0.5rem", borderRadius: 4, maxHeight: "12rem", overflow: "auto", fontSize: "0.8rem" },
  danger: { background: "#c0392b", color: "#fff", border: "none", padding: "0.4rem 0.9rem", borderRadius: 4 },
};
