# A CLI output contract for tools that are also SDK dependencies

A small, reusable design for how a command-line tool should write to **stdout**
and **stderr** so that the *same* invocation is pleasant for a human at a
terminal and reliable for a program that spawned it. It is technology-agnostic;
`zipkit` is the reference implementation and supplies the examples, but nothing
here is specific to archiving.

Throughout, `<tool>` is your program's name and `<verb>` is a subcommand
(`create`, `extract`, `diff`, …).

---

## 1. Why

A modern CLI is often two things at once: a program a person runs, and a
dependency another program shells out to. Those two audiences want opposite
things from the same bytes — a human wants readable prose and live progress; a
caller wants one parseable document and stable framing. The usual failures are
(a) interleaving progress and results on stdout so neither parses, (b) throwing
away the structured detail on failure, and (c) inventing a different output shape
per subcommand so a caller must special-case each.

This contract resolves all three with a few rules that cost almost nothing to
adopt and compose across every subcommand.

---

## 2. The five principles

1. **stdout is one report, emitted once, at the end.** It is read to EOF as a
   whole. It is never streamed, never partial; nothing else is ever written to
   stdout.
2. **stderr is live, line-framed chunks** — progress and faults — each a single
   newline-terminated line.
3. **The report is the single source of truth, dumped as-is** — on success *and*
   failure. Whatever the verb accumulated (work done so far, findings, partial
   results) is serialized. A failure is not a missing report; it is a report
   whose findings contain an error.
4. **Faults are findings.** A domain problem and an operational fault land in the
   *same* findings list. There is no parallel error channel inside the document.
5. **The machine flag changes representation, never content.** Human render and
   structured render are two views of the *same* report.

---

## 3. The two channels

**stdout — the report.** Exactly one document, at the end. A programmatic caller
reads it to EOF, then parses (structured mode) or displays (human mode). Because
it is one final document, stdout is always cleanly redirectable: `<tool> … >
report.json` captures the result and nothing else.

**stderr — live, framed.** Progress and faults as they happen, one line each,
each line written as a single write of the complete `line\n` (no partial writes,
no internal newlines). A human watching the terminal sees both streams
interleaved in write order; a caller reads stderr line by line for live status.

> **Caller contract — drain both streams concurrently.** Read stdout *and*
> stderr at the same time. Reading stdout to EOF *before* draining stderr can
> deadlock once the stderr pipe buffer (~64 KB on most systems) fills under
> chatty progress: the child blocks writing stderr and never finishes stdout.
> Order is preserved *within* each stream but **not** across the two — never
> infer that a stderr line came before a stdout byte.

---

## 4. The report envelope

Every verb, every mode, every outcome emits exactly one envelope to stdout:

```ts
interface Report<Verb, Data> {
  schemaVersion: number;   // 1; the FIRST key; bumped only on a breaking change
  tool: string;            // origin, e.g. "zipkit" — identifies a nested tool's report
  toolVersion: string;     // the version that produced it
  verb: Verb;              // which subcommand
  ok: boolean;             // DERIVED: no finding is at the error tier
  data: Data;              // the verb's payload
}
```

Why each field earns its place:

- **`schemaVersion` first** so a caller can read it without parsing the whole
  document and branch on the contract version it understands.
- **`tool` + `toolVersion`** because a CLI is often invoked by another CLI; the
  origin makes a saved report self-identifying and a merged log attributable.
- **`verb`** so a generic reader does `read → parse → switch (verb)` without
  knowing any payload shape up front.
- **`ok` is derived, not authored** — it is exactly "no error-tier finding." It
  reports *that the verb executed cleanly*, which is **not** the same as the
  verb's domain verdict (see §7). Keeping it derived means it can never
  contradict the findings.
- **`data`** is the per-verb payload. The wrapper stays thin and verb-agnostic on
  purpose; all verb-specific structure lives inside `data`.

The payload is yours to design per verb. The only requirement the envelope places
on it is a `findings: Finding[]` field (§6), since `ok` derives from it.

---

## 5. stderr framing protocol

Each stderr line is one logical chunk, newline-terminated. Two representations,
selected by the machine flag:

**Human (default):**
```
scan: 412 entries
plan: 411 included, 1 excluded, 0 warnings, 0 errors
write: 1843204 bytes
```
A fault is a plain line that looks like an error — no machine prefix required,
because a human reads it.

**Structured (`--json`):** newline-delimited JSON (JSONL), **minified** (one
record per line), each prefixed:
```
zipkit[progress]:{"schemaVersion":1,"event":"scan.done","entries":412}
zipkit[error]:{"schemaVersion":1,"code":"write.read-failed","path":"src/x","message":"EACCES: permission denied"}
```
- The prefix is `<tool>[<kind>]:` — origin plus chunk kind (`progress`, `error`,
  room for more). It is a marker for the caller, not decoration, so the JSON is
  minified and there is **no space after the colon**.
- `<tool>` gives origin (nested tools); `[<kind>]` lets the caller find and
  classify a line in one pass and leaves room for new kinds without a breaking
  change.
- These records are **also a frozen contract** — same `schemaVersion` discipline
  as the envelope.
- A fault emitted live here *also* appears as a finding in the final report —
  belt and suspenders: the caller learns of it immediately *and* it survives in
  the document.

### The reader engine

A caller reconstructs chunks with a line buffer: accumulate bytes, split on the
`\n` **byte**, emit each complete line, keep the trailing partial for the next
read. Under the machine flag, classify each line by its `<tool>[<kind>]:` prefix,
strip it, and `JSON.parse` the remainder. This is reliable under five conditions
— guarantee them on the producer side and the contract holds:

1. **Every chunk is one line, newline-terminated.** (Line-*terminated*, not
   line-*separated* — no leading-newline scheme; trailing `\n` always.)
2. **No chunk contains an internal newline.** Fold newlines out of fault messages
   before emitting (JSON string-escaping handles this for structured records).
3. **Each chunk is written with a single write call** of the full `line\n`, so
   two chunks' bytes never interleave at the source.
4. **The error kind has a reserved prefix progress never uses**, so the caller
   can find faults without parsing every line.
5. **Flush on EOF.** A producer crash can leave a dangling partial with no
   terminating newline; the reader emits whatever remains when the stream ends
   (and may flag it truncated).

Most runtimes provide a line reader that already satisfies the byte-safe
splitting, partial-line carry, and EOF flush — prefer it over hand-rolling.

---

## 6. Findings — the single fault carrier

```ts
type Severity = "error" | "warning" | "info";

interface Finding {
  rule: string;        // a domain rule id, OR a fault code for operational faults
  severity: Severity;  // error blocks the verb's verdict; warning/info do not
  path: string;        // the subject (an entry, an input, an output)
  message: string;     // single-line, human-readable; OS cause folded in for faults
  // …plus any verb-specific optional fields (e.g. a suggested fix)
}
```

One list carries everything that "went notable," at three tiers. The crucial move
is that an **operational fault is just a finding** with `severity: "error"` and
its fault code as `rule` — no second error structure inside the document. This is
what makes "dumped as-is on failure" (§7) work: the failure reason is already
*in* the data, as the last finding, with all the context that accumulated before
it.

`ok` (§4) is exactly `findings.every(f => f.severity !== "error")`.

---

## 7. Single source of truth, and the two kinds of failure

The report is the verb's accumulated state, serialized — on success and on
failure alike. On failure you therefore still get the useful context: what was
renamed to what, which entries were processed, which findings fired *before* the
fault. That context is often the whole point when debugging.

Two kinds of failure are handled differently, and the distinction is worth
naming precisely:

- **Usage faults** — the *invocation* was malformed (bad flags, an invalid
  config, an unopenable input). These happen *before* the verb produces any
  report, so there is nothing to fold them into. They map to the **usage exit
  code** and, under the machine flag, still emit a *minimal* envelope
  (`{…, data:{findings:[the fault]}}`) so stdout is never empty.
- **Operational faults** — something failed *mid-run*, after the verb had begun
  accumulating state (an I/O error partway through). These are **folded into the
  report** as an error-tier finding, alongside everything already accumulated,
  and map to the **failure exit code**.

Keep the "is this a usage fault?" decision in **one** predicate, shared by the
exit-code mapping and the fold decision — duplicating that set across the two is
the classic drift bug. Where the verb's structure already separates validation
from execution (a `plan()` step before a `write()` step), let usage faults
propagate naturally from the validation phase instead.

---

## 8. The file levers

Two optional flags, **independent of the machine flag** — you can have human
stdout *and* a machine file from one run:

- **`--json-out <path>`** — write the same report envelope to a file. It is
  **byte-identical** to what the machine flag prints on stdout.
- A verb may add **targeted exports** for an embedded artifact (zipkit's create
  has `--metadata-out <path>`, the byte-identical embedded manifest), so the
  export can be diffed against the artifact inside the output.

The rule that makes byte-identity hold: **the structured stdout form is always
pretty-printed** (a fixed indent), with no terminal-vs-pipe switch, and the file
is written through the *same* serializer. One serializer, one byte sequence,
two destinations.

---

## 9. Exit codes

| code | meaning |
|---|---|
| `0` | success — the verb's domain verdict is satisfied |
| `1` | the domain verdict failed (a blocking finding, or the verb's own "not ok") |
| `2` | usage error — a malformed invocation (§7) |
| `130` | aborted (SIGINT) |

`ok` (the envelope field) and the **exit code** are related but not equal. `ok`
says the verb ran without an error-tier finding. The exit code keys off the
**per-verb domain verdict**, which may differ: a comparison verb can run
perfectly (`ok: true`) yet exit `1` because it *found a difference* — "differs"
is a normal result, not a fault. Document each verb's verdict explicitly.

---

## 10. The caller's checklist

To consume a tool that follows this contract:

1. Spawn it and **drain stdout and stderr concurrently** (§3).
2. **Read stdout to EOF, then parse once** → the report envelope.
3. **Line-frame stderr**; under the machine flag, classify each line by the
   `<tool>[<kind>]:` prefix and parse the remainder for live progress/faults
   (§5).
4. Check **`schemaVersion`** against what you support.
5. **Switch on `verb`** to interpret `data`.
6. Read **`ok`** for "ran cleanly," and the **exit code** for the domain verdict
   (§9) — they answer different questions.
7. On failure, the report is still there: inspect `data.findings` (the
   error-tier ones are the failure; the rest are context).

---

## 11. Schema evolution

- `schemaVersion` is an integer, the first key of every envelope and every stderr
  record.
- **Additive changes do not bump it** — new optional fields, new enum members,
  new event kinds. Consumers MUST ignore unknown fields and event kinds.
- **Bump only on a breaking change** — removing or renaming a field, changing a
  type or a meaning. A bump is a deliberate, documented event.
- Freeze the shape at your first stable release; before that, the version number
  is still malleable and `1` may change underneath you.

---

## 12. One worked example

`zipkit create src -o out.zip` with one auto-fixed name, in both modes.

**Human:**
```
# stderr (live)
scan: 412 entries
plan: 411 included, 1 excluded, 0 warnings, 0 errors
write: 1843204 bytes
# stdout (final, one shot)
zipkit wrote out.zip
  entries:  411
  bytes:    1843204
  [info] name.invalid-char  a<b.txt — invalid characters substituted
# exit 0
```

**Structured (`--json`):**
```
# stderr (live)
zipkit[progress]:{"schemaVersion":1,"event":"scan.done","entries":412}
zipkit[progress]:{"schemaVersion":1,"event":"plan.done","included":411,"excluded":1}
zipkit[progress]:{"schemaVersion":1,"event":"write.done","bytes":1843204}
# stdout (final, pretty, one shot)
{
  "schemaVersion": 1,
  "tool": "zipkit",
  "toolVersion": "0.1.0",
  "verb": "create",
  "ok": true,
  "data": {
    "mode": "write",
    "output": "out.zip",
    "written": true,
    "bytes": 1843204,
    "findings": [
      { "rule": "name.invalid-char", "severity": "info", "path": "a<b.txt",
        "message": "invalid characters substituted",
        "fix": { "kind": "rename", "to": "a_b.txt" } }
    ],
    "metadata": { "...": "the verb's full payload" }
  }
}
# exit 0
```

Same report, two representations. Generalize `zipkit`/`create`/the `data` shape
to your own `<tool>`/`<verb>`/payload and you have the contract.
