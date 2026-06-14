/**
 * Phase 1 renderer: prove the end-to-end seam. Pick folders/files via the native
 * dialog, ask the SDK for a plan, and render its verdict and findings. The view
 * computes nothing — it renders the typed `PlanData` the SDK returned (verdict
 * from `writable`, counts from `summary`, the `findings` list). Later phases add
 * options, the write/verify/delete actions, and the queue.
 */

import { useState } from "react";
import type { PlanData } from "../../shared/api";

export function App() {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickAndPlan() {
    const inputs = await window.zipkit.chooseInputs();
    if (inputs.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await window.zipkit.plan({ inputs });
    setBusy(false);
    if (result.ok) {
      setPlan(result.plan);
    } else {
      setPlan(null);
      setError(`${result.error.code}: ${result.error.message}`);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", color: "#eee" }}>
      <h1>ZipKit</h1>
      <button onClick={() => void pickAndPlan()} disabled={busy}>
        {busy ? "Planning…" : "Choose folders or files…"}
      </button>
      {error && (
        <p role="alert" style={{ color: "#ff6b6b" }}>
          {error}
        </p>
      )}
      {plan && <PlanView plan={plan} />}
    </main>
  );
}

function PlanView({ plan }: { plan: PlanData }) {
  return (
    <section>
      <h2 style={{ color: plan.writable ? "#4caf50" : "#ff6b6b" }}>
        {plan.writable ? "Windows-safe ✓" : "Blocking issues"}
      </h2>
      <p>
        <code>{plan.output}</code>
      </p>
      <p>
        {plan.summary.included} included, {plan.summary.excluded} excluded,{" "}
        {plan.summary.warnings} warning(s), {plan.summary.errors} error(s)
      </p>
      {plan.findings.length > 0 && (
        <ul>
          {plan.findings.map((f, i) => (
            <li key={i}>
              <code>{f.severity}</code> {f.rule} — {f.message} <small>({f.path})</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
