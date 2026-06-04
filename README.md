# ZipKit

A cross-platform ZIP archiver and portability linter/fixer, usable as both a TypeScript SDK and a CLI. It produces archives that are clean across platforms: an archive made on macOS contains nothing a Windows user will trip over, and the reverse. It also reads back: `extract` validates an archive's integrity (and, against the manifest, its completeness and content identity) and unpacks it.

ZipKit is fundamentally a portability linter with a fixer attached. The compression and container work is the small part; the value is the set of checks and the policy that decides what to do about each one — NFD-decomposed names, Windows-invalid characters, reserved device names, OS junk files, Unix-only attributes, and unknown extra fields.

## How it works

Three layers, with all side effects at the edges:

1. **scan** walks the filesystem and produces raw metadata (read I/O).
2. **plan** is pure: it runs every rule, produces findings, and resolves each into an action. This is the heart of the tool and is unit-tested with synthetic entries.
3. **write** emits the ZIP bytes atomically (write I/O).

A dry run is `scan + plan`; an actual run is `scan + plan + write`. Both share the one pure planning function, so the dry run is faithful to the actual run by construction.

Reading an archive back is the mirror of this — a separate **read** path (`extract`) that parses the container, decompresses and CRC-checks every entry, and either writes the files out or, on a dry run, only reports. The same dry/wet symmetry holds: a dry-run extract does everything an extraction does except touch the output, so validation is faithful to extraction.

## Install

```sh
npm install
npm run build
```

The runtime is Node 22.12 or later, ESM.

## Standard workflows

Copy-paste recipes for the common tasks. Every command exits `0` on success and non-zero on failure, so each line is also a gate; add `--json` for a machine-readable result.

**Create a clean archive.**
```sh
zipkit create ./my-project              # writes ./my-project.zip beside the directory
zipkit create ./my-project -o out.zip   # or name the output explicitly
```
A single directory's *contents* are flattened to the archive root. OS junk (`.DS_Store`, `Thumbs.db`) is dropped and non-portable names are fixed, so the result is clean on macOS and Windows alike.

**Gate a build on portability (CI).**
```sh
zipkit create ./my-project --dry-run --strict
```
Writes nothing (`--dry-run` is the CLI form of `plan()`); exits non-zero on any portability defect under `--strict`.

**Confirm an archive was created successfully.**
```sh
zipkit create ./my-project -o out.zip
zipkit extract out.zip --dry-run
```
The dry-run extract re-reads `out.zip` *from disk*, decompresses every entry, and checks CRC-32. Exit `0` ⇒ a well-formed ZIP whose every entry is intact and readable. (This is the `unzip -t` check; it works on any ZIP.)

**Archive, then safely delete the originals.**
```sh
zipkit create ./my-project -o out.zip
zipkit extract out.zip --dry-run --check-metadata
```
The embedded metadata (on by default) records a SHA-256 per file. The dry-run `--check-metadata` verifies every entry's CRC **and** SHA against the manifest, plus completeness (no missing or extra entry). Exit `0` ⇒ the archive faithfully and completely captures what `create` read — the gate to clear before removing the source. zipkit never auto-validates its own output; this step is yours to run when it matters.

**Extract to a directory.**
```sh
zipkit extract out.zip ./restored              # verifies CRC as it writes; restores times
zipkit extract out.zip ./restored --overwrite  # replace existing files
```
Entries that fail CRC are reported and never written; paths that escape the destination (zip-slip) are skipped.

**Validate a third-party archive.**
```sh
zipkit extract anything.zip --dry-run
```
A CRC integrity test for any ZIP, not only ones zipkit made.

## CLI

```
zipkit create <inputs...> [options]
```

The CLI has two subcommands: `create` builds archives (documented here) and `extract` reads them — extraction and validation (see [Extract and validate](#extract-and-validate)). Flags are grouped by concern, in the order the tool resolves them. Three behaviors are normative:

- **Selection is inclusive by default; rules only subtract.** Everything under the inputs is archived unless an exclude matches it. There is no "include" — to archive a subset of a tree, narrow the **inputs**. `--exclude` and `--exclude-regex` accumulate into one list; any match drops the entry.
- **A trailing slash means directory.** `--exclude 'node_modules/'` targets directories; `--exclude '*.tmp'` targets files and directories.
- **`--dry-run` is the CLI form of calling `plan()`.**

### Source

By default a single directory input is **flattened**: its *contents* land at the archive root, so `zipkit create ./project` stores `project/file.txt` as `file.txt`, not `project/file.txt`. This is by design — the output filename already carries the directory's name, so wrapping it in a same-named folder would only repeat it. Pass `--wrap` to keep the directory name as a top-level folder inside the archive instead.

| Flag | Description |
|---|---|
| `--root <dir>` | Root every input's archive path relative to this directory. Cannot be combined with `--wrap` (CLI) or the SDK's per-input `as`/`flatten`. |
| `--wrap` | For a single directory input, keep its name as the top folder instead of flattening its contents to the root — `project/file.txt` stays `project/file.txt`. |

### Destination

| Flag | Description |
|---|---|
| `-o, --output <path>` | Output archive path. When omitted, the archive is written beside what is archived (`<dirname>.zip`, `<stem>.zip`, or `<parent>.zip`). |
| `--overwrite` | Overwrite an existing output archive. |

### Selection

| Flag | Default | Description |
|---|---|---|
| `--junk <builtin\|none>` | `builtin` | Built-in bidirectional junk preset. |
| `--exclude <pattern>` | | Exclude glob (repeatable). A trailing slash targets directories. |
| `--exclude-regex <pattern>` | | Exclude regex (repeatable). |
| `--skip-empty-files` | off | Drop zero-byte files. |
| `--empty-dirs <keep\|prune>` | `keep` | Empty-directory handling. |
| `--empty-dir-def <strict\|recursive>` | `recursive` | What counts as empty. |

Both exclude flags append to one list; any matching rule drops the entry (the system is inclusive by default, so order doesn't change the outcome — there is no include to override an exclude). A trailing slash on a glob targets directories. Globs follow gitignore conventions: unanchored patterns float at any depth, a leading or interior slash anchors to the root, and `**` spans segments. The same engine and flags are available on `extract` to choose which entries are written.

#### Built-in junk preset

`--junk builtin` (the default) drops these OS-generated files bidirectionally. They report as info findings (`macos.junk` / `windows.junk`) and never block, even under `--strict`. `--junk none` disables the preset for the whole run.

- **macOS:** `.DS_Store`, `__MACOSX/`, `._*` (AppleDouble files), `Icon\r` (custom folder icon), `.Spotlight-V100`, `.Trashes`, `.fseventsd`
- **Windows:** `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `$RECYCLE.BIN/`, `System Volume Information/`

### Naming

| Flag | Default | Description |
|---|---|---|
| `--invalid-char <char>` | `_` | Replacement for invalid characters. Must be a single path component (no slashes, not `.` or `..`), so substitution can never introduce a separator or escape the archive root. |

NFC normalization, the other name fixes, and collision detection are unconditional and carry no knob.

### Entry data

| Flag | Default | Description |
|---|---|---|
| `--symlinks <ignore\|preserve\|follow>` | `ignore` | Symlink handling. `ignore` drops the link (a warning, visible in the plan); `preserve` keeps it as a Unix link entry — it is *not* replaced by its target, but Windows extracts such entries as text files, breaking the clean-byte guarantee; `follow` replaces each link with the real file or directory it points to. Windows `.lnk` shortcut files are ordinary files, not symlinks, and are archived as-is regardless of this flag. |
| `--follow-external` | off | Under `follow`, allow links that escape the input tree. |
| `--timestamps <preserve\|clamp>` | `preserve` | Timestamp policy. `preserve` (default) writes the DOS local-time field *and* two absolute-UTC extras: the NTFS extra (`0x000a`) carries modification, access, and creation times at 100-ns precision across the full date range (what Windows restores), and the Info-ZIP extended-timestamp (`0x5455`) carries the same three times as 1-second UTC values *where each fits its signed 32-bit range* (~1901–2038) — times outside that range are kept only in the NTFS extra and the metadata. A creation time the OS doesn't actually track is omitted rather than fabricated. Unknown extras are skipped by every conforming reader, so this is safe for old tools. `clamp` writes only the DOS local-time field (2-second resolution, clamped to 1980–2107) for a minimal, zero-extra archive. |
| `--timezone <iana>` | host zone | IANA zone (e.g. `Asia/Tokyo`, `UTC`) the DOS local-time field is rendered in. The DOS field stores local wall-clock with no zone attached, so a same-zone reader sees the file's real modification time. Affects only the DOS field — the UTC extras and the metadata record are always UTC. |
| `--store-ext <list>` | (built-in list) | Comma-separated extensions stored without deflating. |
| `--no-store-ext` | | Deflate everything (clear the store list). |
| `--store-all` | | Store every entry. |
| `--compress-all` | | Deflate every entry. |

The store list names already-compressed formats, where attempting deflate is wasted effort. Files outside the list are deflated; the method is decided up front from the extension and is final, so a deflated entry can rarely end up a few bytes larger than its stored form (the writer streams once and does not reconsider). The list is a CPU optimization, never a correctness setting. Borderline formats such as PDF are deliberately left off so `auto` keeps the win on the ones that do compress. Built-in list: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.heic`, `.mp4`, `.mov`, `.mkv`, `.webm`, `.mp3`, `.aac`, `.m4a`, `.flac`, `.zip`, `.gz`, `.7z`, `.rar`, `.docx`, `.xlsx`, `.pptx`, `.woff2`.

### Companion output

| Flag | Default | Description |
|---|---|---|
| `--no-metadata` | (metadata on) | Do not embed the metadata file — produce a plain archive. Metadata is embedded by default (it's why zipkit exists: faithful, high-precision persistence), with a SHA-256 per file. |
| `--metadata-no-hash` | off | Omit the per-file SHA-256, recording CRC-32 only. |
| `--metadata-name <name>` | `_metadata.json` | Metadata entry name. Must be a single path component (no slashes). |

The metadata file is a JSON record of the run, in four parts:

- **Header** — `tool`, `version`, `createdUtc`, `timeZone` (the IANA zone the DOS fields were rendered in), the resolved `policy`, the plan `summary`, and aggregate `totals` (uncompressed and compressed bytes).
- **`entries`** — one record per written entry: `archivePath`, `originalPath`, `sourcePath`, `type`, `method`, `size`, `compressedSize`, `crc32`, `sha256` (unless `--metadata-no-hash`), `mode`, the four stat times `mtime`/`atime`/`ctime`/`btime` (each `{ ns, iso }`, UTC; `btime` is `null` when the platform doesn't track it), `linkTarget` for preserved symlinks, and the `transformations` applied.
- **`excluded`** — dropped entries, each with its `reason`.
- **`findings`** — every finding from the run.

It never stores absolute source paths. The same document is returned from every `create` as `WriteResult.metadata` (typed `Metadata`), so a caller has the full record — timestamps and findings included — without reading the archive back, even when `--no-metadata` skips embedding it.

The metadata file is **always embedded** as an entry at the archive root — a ZIP is a container, so the manifest rides inside it rather than as a loose file that could be separated from the archive or drift out of sync with it. It is therefore covered by the archive's own CRC, and `extract --check-metadata` reads it straight from the zip.

### Container format

| Flag | Default | Description |
|---|---|---|
| `--zip64 <auto\|never\|always>` | `auto` | Zip64 policy. |

### Diagnostics and control

| Flag | Description |
|---|---|
| `--dry-run` | Compute and render the plan; write nothing. The CLI form of `plan()`. |
| `--strict` | Treat warnings as blocking. |
| `--log <path.jsonl>` | Write the event stream as JSONL. |
| `--quiet` | Suppress console progress. |
| `--verbose` | Include per-entry detail in console progress. |
| `--concurrency <n>` | Maximum concurrent file operations. Defaults to the available CPU count, bounded to 4–16. Peak memory is roughly `chunkSize × concurrency` (see [Performance](#performance)). |
| `--chunk-size <size>` | Chunk size for all streamed I/O, in bytes; accepts a `k`/`m` suffix (e.g. `64k`, `1m`). Defaults to 64 KB. |
| `--json` | Emit the plan or result as JSON; suppress the human renderer. |

`--json` suppresses the human renderer and emits the `Plan` (dry run) or `WriteResult` (actual run) as JSON. Errors always go to stderr, so stdout stays valid JSON.

## Extract and validate

```
zipkit extract <archive> [dest] [options]
```

One verb covers reading an archive. Two switches are orthogonal: `--dry-run` decides whether files are written, `--check-metadata` decides whether the archive is reconciled against its manifest. **CRC-32 is always verified** — every entry is decompressed regardless — so `extract <archive> --dry-run` is a pure integrity test (the `unzip -t` shape) that works on **any** ZIP, not only ones zipkit produced. With a `dest` it writes the verified entries; CRC governs writing, so a corrupt entry is reported and never written.

```bash
# Validate integrity only (decompress every entry, check CRC, write nothing)
zipkit extract archive.zip --dry-run

# Validate against the manifest too: completeness (no missing/extra) + SHA-256
zipkit extract archive.zip --dry-run --check-metadata

# Extract to a directory, dropping the manifest entry
zipkit extract archive.zip ./out --exclude _metadata.json
```

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Validate only: verify and report, write nothing. |
| `--overwrite` | off | Overwrite existing files at the destination (otherwise they are preserved and reported as `exists`). |
| `--check-metadata` | off | Reconcile entries against the manifest (no missing/extra) and verify each recorded SHA-256. Requested-but-absent manifest is a hard error. |
| `--metadata-name <name>` | `_metadata.json` | Manifest entry name to look for inside the archive. |
| `--no-timestamps` | (restore on) | Do not restore modification/access times. By default times are restored from the absolute UTC extras when present, falling back to the DOS field interpreted in `--timezone`. |
| `--timezone <iana>` | host zone | Zone used to read the DOS field when an entry carries no UTC time extra. |
| `--on-unsafe <skip\|abort>` | `skip` | Handling of an entry whose path escapes the destination (zip-slip): skip it with a finding, or abort the run. |
| `--symlinks <restore\|skip>` | `restore` | Whether to recreate symlink entries. |
| `--exclude <pattern>` | | Exclude glob — matching entries are verified but not written (repeatable). Trailing slash targets directories. |
| `--exclude-regex <pattern>` | | Exclude regex — matching entries are verified but not written (repeatable). |
| `--json` | | Emit the `ExtractReport` as JSON; suppress the human renderer. |

- **Creation/birth time is not restored** — no portable cross-platform API sets it.
- **Exit code** is `0` when the report is `ok`, else `1`, so validation scripts cleanly.
- **No automatic self-validation** — zipkit does not validate its own output after `create` (a tested compressor is trusted); `extract --dry-run` is there for when you have a reason to check an archive.

## Rules and severity contract

Every rule has a fixed tier, decided by one principle and enforced by a single registry (the `RULE_REGISTRY` constant). Rules never write a tier inline; they read it from the registry, so the boundary between tiers is a single, tested definition and a consumer's CI verdict never flips on an unrelated change.

- **error** — there is no safe, unambiguous automatic resolution; proceeding would corrupt data, lose data, or pick a winner arbitrarily. An error always blocks (`writable = false`), with or without strict gating.
- **warning** — the tool safely auto-fixed the issue, but the finding reflects a portability defect in the source that a careful author might fix upstream. A warning blocks only under `--strict`.
- **info** — routine hygiene the tool performs by design; nothing for the consumer to act on. Info never blocks.

The coupling that prevents drift is exact: **error is the tier that blocks unconditionally.** Severity cannot be reclassified without changing observable blocking behavior, which is visible and tested.

### The registry, in pipeline order

| Rule | Tier | Blocks normally | Blocks under strict | Disposition |
|---|---|---|---|---|
| `path.absolute` | warning | no | yes | strip prefix |
| `path.traversal` | error | yes | yes | abort |
| `path.too-long` | warning | no | yes | keep |
| `macos.junk` | info | no | no | exclude |
| `windows.junk` | info | no | no | exclude |
| `entry.symlink` | warning | no | yes | exclude |
| `name.nfd` | warning | no | yes | normalize to NFC |
| `name.invalid-char` | warning | no | yes | substitute |
| `name.control-char` | warning | no | yes | strip |
| `name.trailing-dot-space` | warning | no | yes | trim |
| `name.reserved` | warning | no | yes | suffix |
| `name.suspicious` | warning | no | yes | keep |
| `entry.duplicate` | info | no | no | deduplicate |
| `collision.case` | error | yes | yes | abort |
| `collision.post-fix` | error | yes | yes | abort |
| `time.pre-1980` | warning | no | yes | clamp |
| `time.post-2107` | warning | no | yes | clamp |
| `compat.zip64` | warning | no | yes | use Zip64 |
| `compat.zip64-required` | error | yes | yes | abort |

Junk removal and same-source deduplication are deliberately `info`: strict gating does not fail a build merely because the tool dropped a `.DS_Store` or collapsed a file that two overlapping inputs both supplied. Strict gating fires on source-side portability defects an author can fix upstream.

Where a policy could otherwise flip a tier, the two outcomes are modeled as separate rules. A collision is always an error — there is no auto-rename option, because choosing which file to rename is the ambiguous resolution that defines the error tier. Zip64 distinguishes `compat.zip64` (used, a warning) from `compat.zip64-required` (needed but disabled by `zip64: never`, an error).

### Exit codes

The CLI exit codes make this a dependable automation contract:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | the run did not produce its result — for `create`, a non-writable plan (a blocking finding, or an existing output without `--overwrite`) or a write failure; for `extract`, a report that is not `ok` (a CRC failure, an unsafe path, or — under `--check-metadata` — a missing/extra entry or SHA mismatch). `--dry-run` honors these, making either a CI gate. |
| `2` | usage error: a missing input path, an archive that cannot be opened, or `extract` without a destination or `--dry-run` |
| `130` | interrupted (SIGINT) |

Errors are written to stderr as `zipkit [<code>]: <message> (<cause>)` — the dot-separated `code` is a stable handle for scripting, and the cause carries the OS-level reason. Under `--json`, errors stay on stderr so stdout remains valid JSON.

## SDK

The `plan → inspect → write` flow is the reason ZipKit is an SDK and not only a CLI: compute the plan, read its `findings`, decide, then write.

```ts
import { ZipKit } from "zipkit";

const zip = new ZipKit({ policy: { strict: true } });

// Plan, inspect, then write.
const plan = await zip.plan({ inputs: ["./my-project"], output: "out.zip" });
if (plan.writable) {
  const result = await zip.write(plan);
  console.log(`wrote ${result.entries} entries (${result.bytes} bytes)`);
} else {
  console.error(plan.findings);
}

// Or plan and write in one call.
await zip.create({ inputs: ["./my-project"], output: "out.zip", overwrite: true });

// Read side: validate (write nothing) or extract. CRC is always checked.
const report = await zip.extract({ archive: "out.zip", dryRun: true, checkMetadata: true });
if (!report.ok) console.error(report.findings);

await zip.extract({ archive: "out.zip", dest: "./restored", overwrite: true });
```

The committed export surface is the `ZipKit` class; the types `ZipKitOptions`, `ArchiveSpec`, `ArchiveInput`, `ArchivePolicy`, `CompressionPolicy`, `MetadataPolicy`, `FilterRule`, `Plan`, `PlanSummary`, `PlannedEntry`, `Finding`, `Severity`, `WriteResult`, `Metadata`, `MetadataEntry`, `MetadataExcluded`, `Transformation`, `UtcTime`, `ExtractSpec`, `ExtractReport`, `ExtractEntryResult`, `LogEvent`; and the errors `ZipKitError`, `ScanError`, `PolicyError`, `WriteError`, `ReadError`, `AbortError` with the type `ZipKitErrorType`.

Progress is observed in real time through the optional `logger` callback, which receives a `LogEvent` stream as the pipeline works. The same stream feeds the SDK callback, the CLI console renderer, and the `--log` JSONL sink.

## The clean-byte guarantee

Every archive holds to a fixed byte contract, so it reads cleanly across platforms and old tools:

- **Names.** The UTF-8 flag (general-purpose bit 11) is always set, so non-ASCII names survive across locales; the host byte is FAT, so no Unix mode leaks.
- **Minimal extra fields.** Only the Zip64 extra when genuinely needed, plus — under timestamp preservation (the default) — the Info-ZIP extended-timestamp (`0x5455`) and NTFS (`0x000a`) extras. Both are standard extras any conforming reader understands or skips, so they are safe for old tools; `--timestamps clamp` drops them for a zero-extra archive.
- **Timestamps.** The DOS date/time field holds *local* wall-clock time in the configured zone (the host zone by default). That field carries no zone, so the absolute UTC truth lives in the two extras above and in the metadata record.
- **Compression.** Deflate via the platform `zlib`, and Store for already-compressed extensions. The method is chosen up front from the extension and is final — entries stream through it once, with no second pass — so a deflated entry can rarely end up a few bytes larger than its stored form. That is an accepted trade for streaming arbitrarily large files in bounded memory (see [Performance](#performance)).
- **Atomic output.** A temporary file is written in the same directory, then renamed — a reader never sees a half-written archive.
- **Self-exclusion.** When the output lives inside the input tree, the archive never contains itself: the output is excluded by file identity (`dev:ino`), exact on every filesystem — a case-insensitive volume that aliases `Out.zip` to `out.zip` excludes it, a case-sensitive one keeps a same-named neighbour. Identity is the *only* self-exclusion; zipkit never guesses from a name that a file is a stale temp, so a real neighbour such as `archive.zip.notes` or a dated `archive.zip.20240604` is always archived.

## Performance

All I/O is streamed in fixed-size chunks, so memory does not scale with file or archive size. Both creating and extracting read, (de)compress, and write in pieces; an arbitrarily large file round-trips in bounded space.

- **Chunk size.** The chunk size — the `highWaterMark` of every read, (de)compress, and write stream — defaults to **64 KB** and is configurable with `--chunk-size` (CLI) or `chunkSize` (SDK), accepting a byte integer with an optional `k`/`m` suffix. It applies to all streamed I/O.
- **Peak memory.** Roughly `chunkSize × concurrency`: each in-flight entry holds about a chunk's worth of buffer rather than its whole file.

The 64 KB default follows the common sequential-I/O sweet spot. Node.js `fs` streams default their [`highWaterMark` to 64 KB](https://nodejs.org/api/stream.html); .NET's `FileStream` defaults to a smaller [4096-byte buffer](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions.buffersize), with Microsoft's guidance being to "run benchmarks and measure" because the ideal size depends on the access pattern and environment; benchmarks of [buffered disk access](https://www.zabkat.com/blog/buffered-disk-access.htm) and [streaming in Node.js](https://blog.appsignal.com/2022/02/02/use-streams-to-build-high-performing-nodejs-applications.html) put the sweet spot around 64 KB, with diminishing or negative returns past ~256 KB as buffer overhead grows. The default is a sound starting point; tune it for your workload.

**Create is sequential; extract is concurrent.** A ZIP archive is a single ordered byte stream — entries are concatenated in order, each followed by the central directory — so creating one is inherently sequential: the writer streams entries one after another into a single file descriptor. Extraction is the opposite: every entry becomes an *independent* output file, so entries run concurrently (bounded by `concurrency`), each streaming to its own file. The OS write-back cache absorbs those parallel writes, so they do not bottleneck the decompressor.

## Scope

In scope:

- Creating clean, portable archives from a source tree.
- Reading them back — extraction, and validation (CRC always; against the embedded manifest, completeness and SHA-256).

Out of scope: repairing or re-writing existing archives; encryption; compression methods beyond Store and Deflate; and multi-volume or split archives.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/
npm test            # vitest
```

## License

MIT © Yoshinao Inoguchi
