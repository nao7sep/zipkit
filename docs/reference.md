# zipkit — Reference

zipkit is a cross-platform ZIP archiver and portability linter/fixer that also extracts and validates. It ships as an **SDK** (the `ZipKit` class), a **CLI** (the `zipkit` bin), and a desktop **GUI**. The SDK is the engine; the CLI is a thin binding over it, and the GUI (still in active development) consumes the same SDK in-process. This reference documents the stable SDK/CLI contract.

Each capability is described once. Where it matters, the SDK method and the CLI subcommand that bind to it are both named — they are two faces of the same operation, not two operations.

The SDK is consumed as source within this repo (no published package). The CLI is built to `bin/zipkit.js` → `dist`/`out` via `tsup` from `src/cli/main.ts`. Types and classes named below are exported from `src/sdk/index.ts`.

---

## The instance and the session

An operation is invoked on a `ZipKit` instance. Constructing the instance fixes the runtime knobs and opens **one logging session**.

`new ZipKit(options?: ZipKitOptions)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `policy` | `DeepPartial<ArchivePolicy>` | none | Instance-level policy. Per-call policy is merged over this, which is merged over the built-in defaults. Validated at construction; an invalid policy throws `PolicyError`. |
| `concurrency` | `number` | `max(4, min(availableParallelism(), 16))` | Max in-flight file operations for the scan and for extraction (each entry streams to its own file). The create **write** is a single ordered byte stream and is always sequential. Must be a positive integer or the constructor throws `PolicyError` (`options.invalid`). |
| `logDir` | `string` | `process.env.ZIPKIT_LOG_DIR`, else `~/.zipkit/logs` | Directory for this instance's session log. |
| `chunkSize` | `number` | `65536` (64 KB) | `highWaterMark` for all streamed read/inflate/deflate/write I/O. Pure runtime concern — never changes the archive bytes. Peak memory ≈ `chunkSize × concurrency`. Must be a positive integer or the constructor throws `PolicyError` (`options.invalid`). |

Behavioral contract of the session:

- One instance is one logging session. A single file `<logDir>/yyyymmdd-hhmmss-fff-utc.log` (JSON Lines) is opened **lazily** on the first verb call and reused; every verb on the instance appends to it. The path is stamped at construction and returned on each result as `log`. An instance that never runs a verb writes no file.
- Lines are appended synchronously; there is no descriptor to close and nothing to flush. Logs are never rotated. Verbs invoked concurrently on the same instance interleave their lines. **Construct a fresh `ZipKit` per logical run** when you want one self-contained session log. The CLI builds one instance per invocation, so a CLI run's log is exactly that run.
- The SDK writes nothing to stdout/stderr. Progress goes only to a per-call `onProgress` hook (below). The sole exception is a console fallback the logger uses if the log file becomes unwritable.

### Per-call options (`ZipKitCallOptions`)

Every verb takes an optional second argument:

| Member | Type | Meaning |
|---|---|---|
| `onProgress` | `(event: LogEvent) => void` | Per-call sink for the live event stream. Same structured `LogEvent` stream that feeds the session log and the CLI's stderr renderer — one producer, many sinks. |
| `signal` | `AbortSignal` | Cancellation. Every verb honors it, stopping cleanly at the next boundary (a phase edge, a walked entry, a streamed chunk) and rejecting with `AbortError`. |

---

## Capability: create / plan / write an archive

Build a clean, cross-portable ZIP from a source tree. This is exposed as a two-phase flow plus a one-shot convenience:

- **SDK** — `plan(spec, options?) → CreateData (mode:"plan")` scans and runs the pure planning pass, writing nothing. `write(plan, options?) → CreateData (mode:"write")` executes a plan. `create(spec, options?) → CreateData (mode:"write")` does both in one call with one logger and one signal.
- **CLI** — `zipkit create <inputs...> [flags]`. With `--dry-run` it calls `plan()` and prints the plan; otherwise it calls `plan()` then `write()`. (The CLI always plans first so a non-writable plan can be reported with exit 1 rather than thrown.)

The `plan → inspect → write` split is the reason zipkit is an SDK: a caller computes the plan, reads `findings` and `writable`, decides, then writes.

> **Plan handle contract.** The object returned by `plan()` is a **live handle**. Pass the *same* object to `write()`. It is safe to inspect and `JSON.stringify` (it carries no absolute source paths), but the writer's instructions ride on it out of band (non-enumerable, via `internal/carrier.ts`). A cloned or re-serialized copy cannot be written and fails with `WriteError` (`write.no-internals`).

### Input: `ArchiveSpec`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `inputs` | `string[]` | yes (≥1) | — | Source file/directory paths. A **single directory** input has its contents flattened to the archive root. **Multiple inputs** each keep their basename as a top-level folder (files land bare), so distinct inputs cannot silently merge. |
| `output` | `string` | no | inferred | Output archive path. When omitted: a single directory → `<dirname>.zip` beside it; a single file → `<stem>.zip` beside it; several inputs sharing one parent → `<parent>.zip` in that parent; several inputs in different parents → error (`PolicyError` `output.ambiguous`). |
| `overwrite` | `boolean` | no | `false` | Authorize replacing an existing output. Without it, a pre-existing output raises a blocking `output.exists` finding and the plan is not writable. |
| `comment` | `string` | no | none | ZIP end-of-central-directory comment (UTF-8). Recorded in the metadata. Must be ≤ 65535 bytes UTF-8 (the EOCD length field is 16-bit) or `PolicyError` (`spec.invalid`). |
| `policy` | `DeepPartial<ArchivePolicy>` | no | defaults | Processing rules (see **Policy** below). Arrays replace wholesale, scalars/objects deep-merge. |

The run's own output archive is excluded from the scan by file identity (dev:ino), so it cannot be archived into itself even when reached under a different casing.

### Result: `CreateData` (discriminated union on `mode`)

`plan()` returns the `"plan"` member; `write()`/`create()` return the `"write"` member (or throw on an operational fault).

`mode: "plan"` — planned, nothing written:

| Field | Type | Meaning |
|---|---|---|
| `mode` | `"plan"` | discriminant |
| `output` | `string` | resolved (intended) output path |
| `log` | `string` | session-log path this run was recorded to |
| `writable` | `boolean` | the gate — false if any blocking (`error`-severity) finding exists, or the output exists without `overwrite` |
| `summary` | `PlanSummary` | counts (see below) |
| `findings` | `Finding[]` | the single source of truth for issues |
| `entries` | `PlannedEntry[]` | pre-write per-entry view (no crc/sha) |

`mode: "write"` — actual create:

| Field | Type | Meaning |
|---|---|---|
| `mode` | `"write"` | discriminant |
| `output` | `string` | resolved output path |
| `log` | `string` | session-log path |
| `writable` | `boolean` | the gate (true on a successful write) |
| `written` | `boolean` | archive fully streamed, fsync'd, renamed |
| `bytes` | `number \| null` | final on-disk size; `null` if not written |
| `zip64` | `boolean` | **exact** post-write Zip64 outcome (read this, not `summary.zip64`, for truth) |
| `summary` | `PlanSummary` | plan summary, carried verbatim |
| `findings` | `Finding[]` | domain + operational findings |
| `metadata` | `Metadata \| null` | the post-write per-entry SSOT (crc/sha/sizes/times); `null` only if a fault hit before it was built |

`PlanSummary`: `{ total, included, excluded, renamed, warnings, errors: number; zip64: boolean }`. Note `summary.zip64` is a **pre-write upper-bound estimate**; the top-level `zip64` on a write result is the exact outcome.

`PlannedEntry`: `{ archivePath, originalPath: string; type: "file"|"dir"; method: "store"|"deflate"; excluded: boolean; excludeReason?: string; findings: Finding[] }`. `archivePath` is the final NFC, forward-slash, relative name; `originalPath` is the on-disk name pre-fix.

### On-disk artifacts

- The archive is written to a **temp file in the output's own directory** and atomically `rename`d into place on success. A cancelled or failed write calls `writer.abort()`, discarding the temp file, so a failed create leaves nothing behind.
- Unless `policy.metadata` is `false`, a `_metadata.json` manifest (the `Metadata` document) is embedded **inside** the archive as the final entry (default name `_metadata.json`). It is never a loose sidecar file.

### Failure modes

| Condition | SDK | CLI exit |
|---|---|---|
| Invalid spec/policy/options | `PolicyError` (`spec.invalid` / `policy.invalid` / `options.invalid`) — a usage fault | 2 |
| Ambiguous output path | `PolicyError` (`output.ambiguous`) — usage fault | 2 |
| Filesystem read failure during scan | `ScanError` | 3 |
| Non-writable plan passed to `write()` | `WriteError` (`write.not-writable`) | 4 |
| Re-serialized plan passed to `write()` | `WriteError` (`write.no-internals`) | 4 |
| Source read / archive write failure | `WriteError` (`write.read-failed` / `write.failed`) | 4 |
| Cancellation | `AbortError` | 130 |
| **Negative verdict** (plan not writable) | not thrown — `writable: false` on the result | 1 (CLI sets this directly) |

Exit 1 is the CLI's "the verb ran cleanly but the answer is no" signal for a non-writable plan; it is set by the verb, not via a thrown fault.

### CLI flags (`zipkit create <inputs...>`)

Flags map onto `ArchiveSpec` + per-call policy. `-o, --out <path>` → `output`; `--overwrite`; `--comment <text>`. Policy flags (all optional, overriding defaults): `--no-junk`, `--exclude <glob>` / `--exclude-regex <re>` (repeatable, appended to one shared ordered exclude list; trailing slash on a glob targets directories), `--skip-empty-files`, `--empty-dirs <keep|prune>`, the six name-rule actions (`--name-nfc`, `--name-invalid`, `--name-control`, `--name-trailing`, `--name-reserved` each `<fix|warn|error|none>`; `--name-suspicious <warn|error|none>`), `--replacement <char>`, `--symlinks <ignore|preserve|follow>`, `--follow-external`, `--timezone <iana>`, `--no-stored`, `--store <ext>` (repeatable, comma-lists ok), `--level <1-9>`, `--no-metadata`, `--no-hash`, `--metadata-name <name>`. Control: `--dry-run` (= `plan()`), `--quiet` (suppress stderr progress, not errors), `-j, --jobs <n>` (→ `concurrency`), `--chunk-size <size>` (→ `chunkSize`; accepts a `k`/`m` suffix, e.g. `64k`, `1m`).

The CLI prints exactly one JSON success document (the result object) on stdout — pretty-indented on a TTY, compact when piped. Errors render on stderr only.

---

## Capability: extract / validate an archive

One verb reads an archive: it verifies every entry's CRC-32, optionally reconciles against the embedded manifest and verifies recorded SHA-256s, and — unless `dryRun` is set — writes the verified entries to a destination. A dry run writes nothing and is a pure integrity test (`unzip -t` shape) that works on **any** ZIP, not only zipkit-produced ones.

- **SDK** — `extract(spec, options?) → ExtractData`.
- **CLI** — `zipkit extract <archive> [dest] [flags]`.

The two switches are orthogonal: `dryRun` decides whether files are written; `checkMetadata` decides whether the archive is reconciled against its manifest. CRC-32 is always verified — every entry is decompressed regardless — so filtering selects *output* while integrity always covers the *whole archive*.

### Input: `ExtractSpec`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `archive` | `string` | yes | — | The `.zip` file to read. |
| `dest` | `string` | required unless `dryRun` | — | Output directory. Ignored on a dry run; a missing `dest` on a real run throws `ReadError` (`read.no-dest`, a usage fault). |
| `overwrite` | `boolean` | no | `false` | Overwrite existing files at the destination; otherwise an existing target is skipped (`exists`). |
| `dryRun` | `boolean` | no | `false` | Verify only, write nothing. |
| `checkMetadata` | `boolean` | no | `false` | Reconcile entries against the manifest and verify recorded SHA-256s. |
| `metadataName` | `string` | no | `_metadata.json` | Manifest entry name to look for inside the archive. Must be a single safe path component. |
| `timestamps` | `"restore" \| "none"` | no | `"restore"` | Restore modification/access times to extracted files (best-effort). |
| `timezone` | `string` | no | host zone | IANA zone used to interpret an entry's DOS local-time field when it has no UTC time extra. Must be a valid IANA name. |
| `onUnsafe` | `"skip" \| "abort"` | no | `"skip"` | Handling of entries whose resolved path escapes `dest` (zip-slip, lexical or symlink-indirected). `abort` fails the run with `ReadError` (`read.unsafe-path`). |
| `symlinks` | `"restore" \| "skip"` | no | `"restore"` | Whether to recreate symlink entries. |
| `exclude` | `FilterRule[]` | no | none | Exclusion rules. A matching entry is still verified (CRC, and SHA under `checkMetadata`) but is not written. |

### Result: `ExtractData`

| Field | Type | Meaning |
|---|---|---|
| `archive` | `string` | the archive read |
| `log` | `string` | session-log path |
| `dest` | `string \| null` | destination; `null` on a dry run |
| `dryRun` | `boolean` | whether this was verify-only |
| `wrote` | `boolean` | whether any file was actually written |
| `reportOk` | `boolean` | **domain verdict**: no CRC failure, no unsafe path, and (under `checkMetadata`) no missing/extra entry and no SHA mismatch |
| `manifest` | `{ name: string } \| null` | the embedded manifest used, when `checkMetadata` was requested |
| `summary` | object | `{ total, written, skipped, crcFailed, shaMismatched: number }` |
| `entries` | `ExtractEntryResult[]` | per-entry outcomes |
| `missing` | `string[]` | in the manifest but absent from the archive (`checkMetadata`) |
| `extra` | `string[]` | in the archive but absent from the manifest (`checkMetadata`) |
| `findings` | `Finding[]` | the SSOT fault carrier |

`ExtractEntryResult`: `{ archivePath: string; type: "file"|"dir"|"symlink"; crc: "ok"|"fail"; sha?: "ok"|"mismatch"|"absent"; written: boolean; skipped?: "dry-run"|"crc-fail"|"unsafe"|"excluded"|"exists"|"symlink-skip"; outputPath?: string }`. `sha` is present only under `checkMetadata`.

`reportOk` is distinct from any envelope-level "ok": a clean run whose result is simply "not ok" (e.g. a CRC failure) is **not** an error — the verb returns normally with `reportOk: false`, and the CLI exits 1.

### Behavioral contract

- **CRC governs writing.** Each entry streams through inflate to a temp file in the destination; only a CRC-clean entry that also passes the path-safety, exclusion, and overwrite gates is renamed into place. A corrupt entry's temp file is discarded and it is never written.
- **Zip-slip safety.** Parent directories are created one component at a time as real directories, never following or creating *through* a symlink. An entry whose path (lexically, or via a symlinked ancestor) or whose restored symlink target would land outside `dest` is treated as `unsafe`: written nowhere, recorded as an error finding, and (under `onUnsafe: "abort"`) fails the run.
- **Completeness** (`missing`/`extra`) is computed from entry-name sets, independent of the decompression loop.
- Symlink times are not restored (no portable `lutimes`); file times are best-effort and never fail the write.

### On-disk artifacts

Per-entry temp files `.zk-<pid>-<tag>.tmp` are staged in `dest` and renamed into place on success (or removed on CRC failure / unsafe / abort). On a dry run no temp files are written. The destination directory is created (`recursive`) before extraction on a real run.

### Failure modes

| Condition | SDK | CLI exit |
|---|---|---|
| Invalid extract spec | `PolicyError` (`spec.invalid`) | 2 |
| Missing `dest` on a non-dry run | `ReadError` (`read.no-dest`, usage) | 2 |
| Archive cannot be opened | `ReadError` (`read.open-failed`, usage) | 2 |
| Not a well-formed ZIP / unsupported method | `ReadError` | 5 |
| `checkMetadata` requested but manifest absent | `ReadError` (`read.manifest-missing`) | 5 |
| Manifest is not valid JSON | `ReadError` (`read.manifest-invalid`) | 5 |
| Target file unwritable during extraction | `ReadError` (`read.write-failed`) | 5 |
| Unsafe path with `onUnsafe: "abort"` | `ReadError` (`read.unsafe-path`) | 5 |
| Cancellation | `AbortError` | 130 |
| **Negative verdict** (`reportOk: false`) | not thrown — on the result | 1 (CLI sets directly) |

Note the distinction: a missing manifest *requested* via `checkMetadata` is a hard `ReadError` (exit 5), whereas a CRC failure or SHA mismatch is a clean result with `reportOk: false` (exit 1).

### CLI flags (`zipkit extract <archive> [dest]`)

`--dry-run`, `--overwrite`, `--check-metadata`, `--metadata-name <name>`, `--no-timestamps` (→ `timestamps: "none"`), `--timezone <iana>`, `--on-unsafe <skip|abort>`, `--symlinks <restore|skip>`, `--exclude <glob>` / `--exclude-regex <re>` (repeatable; trailing slash targets directories), `--quiet`, `-j, --jobs <n>` (→ `concurrency`), `--chunk-size <size>` (→ `chunkSize`). The verb prints its `ExtractData` as one JSON document on stdout and exits 1 when `reportOk` is false.

---

## Policy (`ArchivePolicy`)

The portion of configuration that decides how each entry is treated. Supplied partially (`DeepPartial`) at instance and/or call level; merged over the built-in defaults. **Arrays replace** the lower layer's array wholesale; scalars and nested objects deep-merge.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `junk` | `"builtin" \| "none"` | `"builtin"` | The OS-junk exclusion preset (macOS/Windows/Linux junk → `info`-severity excludes). |
| `filters` | `FilterRule[]` | `[]` | Exclusion rules. The system is inclusive by default; every rule excludes, there is no "include". To archive a subset, narrow the inputs. |
| `emptyFiles` | `"keep" \| "skip"` | `"keep"` | Whether to drop zero-byte files. |
| `emptyDirs` | `"keep" \| "prune"` | `"keep"` | Whether to drop empty directories. |
| `names` | `NameRules` | see below | Per-defect portability handling. |
| `symlinks` | `"ignore" \| "preserve" \| "follow"` | `"ignore"` | Symlink handling. |
| `followExternal` | `boolean` | `false` | Under `follow`, allow links escaping the input tree. |
| `timezone` | `string` (IANA) | host zone | Zone the ZIP **DOS local-time** field is rendered in. Affects only that field — the extended-timestamp/NTFS extras and the metadata record are always UTC. Offsets and POSIX TZ strings are rejected. |
| `compression` | `CompressionPolicy` | see below | Store-vs-deflate decision and deflate level. |
| `metadata` | `false \| MetadataPolicy` | `{ name: "_metadata.json", hash: true }` | Embedded manifest, or `false` for a plain archive. |

`FilterRule`: `{ pattern: string; match: "glob"|"regex"|"literal" (default "glob"); target: "file"|"dir"|"both" (default "both") }`. A `regex` pattern that does not compile is rejected (`PolicyError`).

`CompressionPolicy`: `{ stored: "builtin"|"none" (default "builtin"); store: string[] (default []); level: number 1–9 (default 6) }`. `stored: "builtin"` seeds the store set with a curated list of already-compressed formats (images, video, audio, archives, zip-based docs/packages, etc.) and deflates the rest; `"none"` seeds it empty. `store` extensions are normalized to lowercase-dotted form (`.txt`, `txt`, `.TXT` are equivalent). The store/deflate method is decided at plan time and is final.

`NameRules` (each defect takes a `NameAction` = `fix`|`warn`|`error`|`none`, except `suspicious` = `warn`|`error`|`none`). `fix` repairs and records an `info` finding + a transformation; `warn` leaves it and records a `warning`; `error` leaves it and **fails the run**; `none` is silent. Defaults: `nfc: fix`, `invalidChars: fix`, `invalidCharReplacement: "_"`, `controlChars: fix`, `trailingDotSpace: fix`, `reserved: fix`, `suspicious: warn`. The `invalidCharReplacement` must be a single safe path component (no slashes, not `.`/`..`). Suspicious characters are kept by design, so that rule has no `fix`.

`MetadataPolicy`: `{ name: string (single safe path component); hash: boolean (default true) }`. `hash: false` records CRC-32 only; SHA-256 is on by default.

---

## Findings and the rule registry

A `Finding` is the single sanctioned issue record: `{ rule: string; severity: "error"|"warning"|"info"; path: string; message: string; fix?: { kind: "rename"|"exclude"|"normalize-attrs"; to?: string } }`.

**Severity decides blocking and nothing else.** An `error` blocks the write (makes the plan non-writable); `warning` and `info` never do. There is no separate "strict" mode — to make an issue block, set its severity to `error` (for name rules, via the `names` policy action).

Built-in rule ids and their default severities (name-rule severities are chosen per run from the policy action — `fix→info`, `warn→warning`, `error→error`):

| Rule | Default severity | Disposition |
|---|---|---|
| `path.absolute` | warning | strip prefix |
| `path.traversal` | error | abort |
| `path.too-long` | warning | keep |
| `macos.junk` / `windows.junk` / `linux.junk` | info | exclude |
| `entry.symlink` | warning | exclude |
| `name.nfd` | info | normalize to NFC |
| `name.invalid-char` | info | substitute |
| `name.control-char` | info | strip |
| `name.trailing-dot-space` | info | trim |
| `name.reserved` | info | suffix |
| `name.suspicious` | warning | keep |
| `entry.duplicate` | info | deduplicate |
| `collision.case` / `collision.post-fix` | error | abort |
| `time.pre-1980` / `time.post-2107` | warning | clamp |
| `output.exists` | error | overwrite |

The extract pass also records findings under non-registry rule ids with explicit severity: `extract.crc-fail` (error), `extract.sha-mismatch` (error), `extract.unsafe-path` (error), `extract.missing` (error), `extract.extra` (warning). Operational faults are also folded in as `error` findings carrying the fault code as `rule`.

---

## The metadata document (`Metadata`)

Returned from every successful `create`/`write` (as `result.metadata`) and embedded as `_metadata.json` unless `policy.metadata` is `false`. The lossless structured record of a run:

`{ tool, version: string; createdUtc: UtcTime; timeZone: string; comment?: string; policy: ArchivePolicy; summary: PlanSummary; totals: { uncompressedBytes, compressedBytes: number }; timeRange: { oldest, newest: ExtremeEntry } | null; entries: MetadataEntry[]; excluded: MetadataExcluded[]; findings: Finding[] }`.

- `UtcTime`: `{ ns: string; iso: string }` — a UTC instant as a lossless nanosecond count and an ISO-8601 string.
- `MetadataEntry`: per written entry — `{ archivePath, originalPath, sourcePath: string; type: "file"|"dir"|"symlink"; method: "store"|"deflate"; size, compressedSize, crc32: number; sha256?: string; mode: number; mtime, atime, ctime: UtcTime; btime: UtcTime | null; linkTarget?: string; transformations: Transformation[] }`. `sha256` is present when hashing was enabled (the default); `btime` is `null` when the platform does not track creation time.
- `Transformation`: `{ rule, before, after: string }` — one applied name fix.
- `MetadataExcluded`: `{ archivePath, originalPath: string; type: "file"|"dir"|"symlink"; reason?: string }`.
- `ExtremeEntry`: `{ archivePath: string; mtime: UtcTime }`. `timeRange` is computed over file/symlink entries only and is `null` when the set has no such entry (e.g. an archive of only empty directories).

All metadata times are UTC; only the ZIP DOS local-time field uses `timeZone`.

---

## Events (`LogEvent`)

The one structured stream fed to `onProgress`, the CLI's stderr renderer, and the session log. The logger stamps each emitted body with `time` (UTC ISO-8601 with milliseconds and `Z`) and a short human-readable `message`; `stage` and `level` ride alongside the discriminated `event` fields.

`LogEvent = { time, message: string } & { stage: LogStage; level: LogLevel } & LogEventBody`, where `LogStage` ∈ `session|scan|plan|write|extract` and `LogLevel` ∈ `debug|info|warn|error`.

`LogEventBody` is a discriminated union on `event` (no untyped data bag). The variants: `session.start` (`version, concurrency, chunkSize`), `scan.start` (`inputs`), `scan.dir` (`path`), `scan.symlink-unreadable` (`path`), `scan.done` (`entries, prunedDirs`), `plan.done` (`total, included, excluded, renamed, warnings, errors, writable`), `entry.excluded` (`path, reason?`), `entry.renamed` (`path, from`), `entry.flagged` (`rule, path, severity`), `write.start` (`entries`), `entry.written` (`path`), `write.done` (`bytes, zip64`), `extract.start` (`entries, write`), `entry.verified` (`path`), `extract.done` (`total, crcFailed, shaMismatched, written, skipped, reportOk`), and `fault` (`code, detail, cause?`). Each verb emits one `session.start` line once per session (the first call), the relevant phase events, and — on failure — a terminal `fault` event recorded under the stage matching the fault's domain.

---

## Error types and exit codes

The SDK error hierarchy (`ZipKitError` abstract base) carries a discriminating `errorType` ∈ `scan|policy|write|read|abort`, a stable dot-separated `code`, and a `usage` boolean (whether the fault is the caller's to fix). Consumers can branch on `errorType` without importing the concrete classes.

Exported classes: `ScanError` (`scan`), `PolicyError` (`policy`, always a usage fault), `WriteError` (`write`), `ReadError` (`read`), `AbortError` (`abort`, code `aborted`).

The single classifier `exitCodeFor(err)` maps thrown faults to CLI exit codes:

| Outcome | Exit code |
|---|---|
| Success | `0` |
| Negative domain verdict (non-writable plan, `reportOk: false`) — set by the verb, not thrown | `1` |
| Usage fault (bad flags/spec, unopenable input/archive, missing dest) | `2` |
| Runtime `scan` fault | `3` |
| Runtime `write` fault | `4` |
| Runtime `read`/extract fault | `5` |
| Cancellation (`AbortError`) | `130` |

The CLI maps Commander's own errors to `2` (and help/`--version` to `0`). On failure the CLI renders the fault on **stderr** only — a usage fault as a plain `error: <message>` line, any other fault as `{ error: { type, code, message } }` JSON — leaving stdout empty. The exit code is the machine signal; stderr is the readable rendering of the same fault.

### Cancellation contract

Every verb honors `options.signal` and rejects with `AbortError` at the next boundary. A create write that is cancelled discards its temp file (nothing lands); an extract honors the signal between streamed chunks and before each rename so no file is published after the abort instant. In the CLI, the first `SIGINT` aborts the current run (a 2-second grace timer then forces exit `130`); a second SIGINT exits immediately. Cancellation is a normal outcome with its own exit code, not a rendered error.

---

## GUI binding (note only)

A desktop GUI (Electron, under `src/gui/`) consumes the same SDK in-process — `src/gui/main/runtime.ts` imports `ZipKit` and `ZipKitError` from the SDK, and the GUI's shared layer reuses the SDK's `ArchiveSpec`, `CreateData`, `ExtractData`, `Finding`, `LogEvent`, and policy types. The GUI is in active development; the SDK and CLI above are the stable contract. The same `LogEvent` stream and the same `~/.zipkit/logs` session-log convention back the GUI.
