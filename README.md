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
zipkit create ./my-project --dry-run \
  --name-nfc error --name-invalid error --name-reserved error
```
Writes nothing (`--dry-run` is the CLI form of `plan()`); exits non-zero when the plan is not writable. Each name guardrail set to `error` turns that defect into a blocking failure (collisions and path traversal always block). Leave the actions at their `fix` default and the same command instead *repairs* the names and exits zero.

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
| `--comment <text>` | Archive comment, written to the ZIP end-of-central-directory record (UTF-8, up to 65535 bytes) and recorded in the metadata. |

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

`--junk builtin` (the default) drops these OS-generated files bidirectionally. They report as info findings (`macos.junk` / `windows.junk` / `linux.junk`) and never block. `--junk none` disables the preset for the whole run.

**What earns a place in the preset:** only files an **operating system generates on its own** — thumbnail caches, trash/index folders, resource-fork sidecars, volume metadata — names that are never a real user file, so dropping them is always safe. Project artifacts (`.git/`, `node_modules/`, build output) and editor backups (`*~`, `.swp`) are deliberately *not* junk: they are real files you might want, so excluding them is your explicit `--exclude` decision, not a silent default.

- **macOS:** `.DS_Store`, `__MACOSX/`, `._*` (AppleDouble files), `Icon\r` (custom folder icon), `.Spotlight-V100`, `.DocumentRevisions-V100`, `.TemporaryItems`, `.Trashes`, `.fseventsd`, `.apdisk`, `.com.apple.timemachine.donotpresent`, `.VolumeIcon.icns`
- **Windows:** `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `$RECYCLE.BIN/`, `System Volume Information/`
- **Linux / freedesktop:** `.Trash-*/`, `.directory` (KDE), `.nfs*` (NFS silly-rename temporaries)

### Naming

Each non-portable name class is governed by its own action, so a Linux-only run can stop the Windows-specific fixes while a CI gate can make any of them fail the build:

| Action | Effect |
|---|---|
| `fix` (default) | Repair the name; record an `info` finding and the transformation. |
| `warn` | Leave it; record a `warning` (does not block). |
| `error` | Leave it; record an `error` (the run fails). |
| `none` | Leave it; record nothing. |

| Flag | Default | Description |
|---|---|---|
| `--name-nfc <fix\|warn\|error\|none>` | `fix` | Non-NFC names (e.g. macOS NFD) → NFC. |
| `--name-invalid <fix\|warn\|error\|none>` | `fix` | Windows-illegal characters `< > : " \| ? * \`. |
| `--name-control <fix\|warn\|error\|none>` | `fix` | Control characters below `0x20`. |
| `--name-trailing <fix\|warn\|error\|none>` | `fix` | Trailing dots or spaces (which Windows silently strips). |
| `--name-reserved <fix\|warn\|error\|none>` | `fix` | Reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9`). |
| `--name-suspicious <warn\|error\|none>` | `warn` | Zero-width / bidi-override characters. Kept by design, so there is no `fix`. |
| `--invalid-char <char>` | `_` | Replacement used when `--name-invalid` repairs a name. A single path component (no slashes, not `.` or `..`), so substitution can never introduce a separator or escape the archive root. |
| `--collision-case <insensitive\|sensitive>` | `insensitive` | Whether two archive paths that differ only by case collide. `insensitive` catches clashes that would break on macOS/Windows; `sensitive` allows them, for archives targeting only case-sensitive filesystems. |

A collision is always an `error` (there is no auto-rename — choosing which file to rename is the ambiguous resolution that defines the tier), but `--collision-case sensitive` narrows what counts as a collision to exact post-fix matches.

### Entry data

| Flag | Default | Description |
|---|---|---|
| `--symlinks <ignore\|preserve\|follow>` | `ignore` | Symlink handling. `ignore` drops the link (a warning, visible in the plan); `preserve` keeps it as a Unix link entry — it is *not* replaced by its target, but Windows extracts such entries as text files, breaking the clean-byte guarantee; `follow` replaces each link with the real file or directory it points to. Windows `.lnk` shortcut files are ordinary files, not symlinks, and are archived as-is regardless of this flag. |
| `--follow-external` | off | Under `follow`, allow links that escape the input tree. |
| `--timestamps <preserve\|clamp>` | `preserve` | Timestamp policy. `preserve` (default) writes the DOS local-time field *and* two absolute-UTC extras: the NTFS extra (`0x000a`) carries modification, access, and creation times at 100-ns precision across the full date range (what Windows restores), and the Info-ZIP extended-timestamp (`0x5455`) carries the same three times as 1-second UTC values *where each fits its signed 32-bit range* (~1901–2038) — times outside that range are kept only in the NTFS extra and the metadata. A creation time the OS doesn't actually track is omitted rather than fabricated. Unknown extras are skipped by every conforming reader, so this is safe for old tools. `clamp` writes only the DOS local-time field (2-second resolution, clamped to 1980–2107) for a minimal, zero-extra archive. |
| `--timezone <iana>` | host zone | IANA zone (e.g. `Asia/Tokyo`, `UTC`) the DOS local-time field is rendered in. The DOS field stores local wall-clock with no zone attached, so a same-zone reader sees the file's real modification time. Affects only the DOS field — the UTC extras and the metadata record are always UTC. |
| `--stored <builtin\|none>` | `builtin` | Baseline of extensions kept uncompressed. `builtin` seeds the store set with the curated already-compressed formats; `none` seeds it empty, so everything is deflated unless named by `--store`. |
| `--store <ext>` | (none) | Keep this extension uncompressed, **added** to the `--stored` baseline. Written with or without a leading dot and in any case (`bin`, `.bin`, `.BIN` are equivalent). Repeatable, and a single flag may carry a comma list (`--store bin,iso`). |
| `--level <1-9>` | `6` | Deflate level, 1 (fastest) to 9 (smallest). Affects only deflated entries. |

The store set is the `--stored` baseline plus any extensions you add with `--store`; a file whose extension is in the set is stored, otherwise deflated. The method is decided up front from the extension and is final, so a deflated entry can rarely end up a few bytes larger than its stored form (the writer streams once and does not reconsider). Under the default `--stored builtin` the baseline is the curated list below, and `--store` extends it. Use `--stored none` to drop the built-ins entirely: on its own it deflates everything (`--stored none` with no `--store`), or with `--store` it stores *only* the extensions you name.

**What earns a place in the built-in set:** an extension is included only when it is **both used often and almost always already compressed**, so deflating it spends CPU for no realistic gain. A large list does no harm as long as both hold. Because the method is final, a wrong "store" guess is a permanent miss, so formats that are common but *not* reliably compressed are deliberately left off — PDF (sometimes compresses), `.iso` (raw image), `.wav`/`.aiff` (PCM audio), `.bmp`/`.tiff` (often uncompressed), `.ttf`/`.otf` (raw font tables — only `.woff`/`.woff2` are pre-compressed), and `.ts` (almost always TypeScript source, not an MPEG transport stream). If a listed extension turns out not to be reliably compressed, it should be removed.

Built-in list:
- **Images:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.heic`, `.heif`, `.avif`
- **Video:** `.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`, `.wmv`
- **Audio:** `.mp3`, `.aac`, `.m4a`, `.flac`, `.ogg`, `.oga`, `.opus`, `.wma`
- **Archives (already compressed):** `.zip`, `.gz`, `.7z`, `.rar`, `.bz2`, `.xz`, `.zst`, `.tgz`
- **Documents (zip-based):** `.docx`, `.xlsx`, `.pptx`, `.docm`, `.xlsm`, `.pptm`, `.odt`, `.ods`, `.odp`, `.epub`
- **Packages (zip-based):** `.jar`, `.war`, `.apk`, `.ipa`, `.whl`, `.nupkg`, `.vsix`
- **Fonts:** `.woff2`, `.woff`

### Companion output

| Flag | Default | Description |
|---|---|---|
| `--no-metadata` | (metadata on) | Do not embed the metadata file — produce a plain archive. Metadata is embedded by default (it's why zipkit exists: faithful, high-precision persistence), with a SHA-256 per file. |
| `--metadata-no-hash` | off | Omit the per-file SHA-256, recording CRC-32 only. |
| `--metadata-name <name>` | `_metadata.json` | Metadata entry name. Must be a single path component (no slashes). |

The metadata file is a JSON record of the run, in four parts:

- **Header** — `tool`, `version`, `createdUtc`, `timeZone` (the IANA zone the DOS fields were rendered in), `comment` (present only when one was set), the resolved `policy`, the plan `summary`, and aggregate `totals` (uncompressed and compressed bytes).
- **`entries`** — one record per written entry: `archivePath`, `originalPath`, `sourcePath`, `type`, `method`, `size`, `compressedSize`, `crc32`, `sha256` (unless `--metadata-no-hash`), `mode`, the four stat times `mtime`/`atime`/`ctime`/`btime` (each `{ ns, iso }`, UTC; `btime` is `null` when the platform doesn't track it), `linkTarget` for preserved symlinks, and the `transformations` applied.
- **`excluded`** — dropped entries, each with its `reason`.
- **`findings`** — every finding from the run.

It never stores absolute source paths. The same document is returned from every `create` as `CreateData.metadata` (typed `Metadata`) on a real write, so a caller has the full record — timestamps and findings included — without reading the archive back, even when `--no-metadata` skips embedding it.

The metadata file is **always embedded** as an entry at the archive root — a ZIP is a container, so the manifest rides inside it rather than as a loose file that could be separated from the archive or drift out of sync with it. It is therefore covered by the archive's own CRC, and `extract --check-metadata` reads it straight from the zip.

### Container format

| Flag | Default | Description |
|---|---|---|
| `--zip64 <auto\|never\|always>` | `auto` | Zip64 policy. |

### Diagnostics and control

| Flag | Description |
|---|---|
| `--dry-run` | Compute and render the plan; write nothing. The CLI form of `plan()`. |
| `--log <path.jsonl>` | Write the event stream as JSONL. |
| `--quiet` | Suppress console progress. |
| `--verbose` | Include per-entry detail in console progress. |
| `--concurrency <n>` | Maximum concurrent file operations. Defaults to the available CPU count, bounded to 4–16. Peak memory is roughly `chunkSize × concurrency` (see [Performance](#performance)). |
| `--chunk-size <size>` | Chunk size for all streamed I/O, in bytes; accepts a `k`/`m` suffix (e.g. `64k`, `1m`). Defaults to 64 KB. |
| `--json` | Emit the report envelope as pretty JSON on stdout; convert progress to JSONL on stderr. |

stdout always carries **exactly one report**, emitted once at the end — on success *and* failure. Without `--json` it is the human render; with `--json` it is the report envelope `{ schemaVersion, tool, toolVersion, verb, ok, data }`, where `data` is the `CreateData` payload (a discriminated union on `mode: "plan" | "write"`). `--json` stdout is always pretty (indent 2). stdout is the result channel and is cleanly redirectable to a file (`zipkit create … --json > report.json`).

Under `--json`, stderr is line-framed JSONL: progress as `zipkit[progress]:{…}` and faults as `zipkit[error]:{…}`, each a single minified record with no space after the colon. Drain stdout and stderr concurrently.

A malformed numeric flag — `--chunk-size`, `--concurrency`, or `--level` given a non-number, or a value the SDK rejects as out of range (a non-positive size, a level outside 1–9) — is a usage error (exit `2`), never silently ignored. The command line only coerces the string to a number; the SDK owns the bounds, so a library caller and the CLI reject the same values.

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
| `--log <path.jsonl>` | | Write the event stream as JSONL (the same stream the console renderer and SDK `onProgress` hook see). Written regardless of `--quiet`. |
| `--json` | | Emit the report envelope (with the `ExtractData` payload) as pretty JSON on stdout; convert progress to JSONL on stderr. |

- **Creation/birth time is not restored** — no portable cross-platform API sets it.
- **Exit code** is `0` when the report's domain verdict `reportOk` holds, `1` when it does not (a clean run that simply failed validation), and `5` when reading the archive itself threw mid-run — so validation scripts cleanly.
- **No automatic self-validation** — zipkit does not validate its own output after `create` (a tested compressor is trusted); `extract --dry-run` is there for when you have a reason to check an archive.

## Rules and severity contract

Severity decides one thing and nothing else: **an `error` blocks the write (`writable = false`); a `warning` and an `info` never do.** There is no separate strict mode — a caller who wants an issue to block sets that issue to `error`.

- **error** — either there is no safe, unambiguous automatic resolution (a collision, a path traversal — proceeding would corrupt or lose data, or pick a winner arbitrarily), or a name guardrail was explicitly set to `error`. Always blocks.
- **warning** — a portability defect that was left as-is (a guardrail set to `warn`, an ignored symlink, an out-of-range timestamp). Reported, never blocks.
- **info** — routine hygiene the tool performed by design: a name it repaired (`fix`), junk it dropped, a duplicate it collapsed. Nothing to act on.

Most rules have a fixed tier, stamped by a single registry (the `RULE_REGISTRY` constant). The **name rules are the exception**: their tier is chosen per run from the `names` policy action — `fix` → `info`, `warn` → `warning`, `error` → `error` — so the same rule reports at whatever tier you asked for.

### The registry, in pipeline order

| Rule | Tier | Disposition |
|---|---|---|
| `path.absolute` | warning | strip prefix |
| `path.traversal` | error | abort |
| `path.too-long` | warning | keep |
| `macos.junk` | info | exclude |
| `windows.junk` | info | exclude |
| `linux.junk` | info | exclude |
| `entry.symlink` | warning | exclude |
| `name.nfd` | per action | normalize to NFC |
| `name.invalid-char` | per action | substitute |
| `name.control-char` | per action | strip |
| `name.trailing-dot-space` | per action | trim |
| `name.reserved` | per action | suffix |
| `name.suspicious` | per action | keep |
| `entry.duplicate` | info | deduplicate |
| `collision.case` | error | abort |
| `collision.post-fix` | error | abort |
| `time.pre-1980` | warning | clamp |
| `time.post-2107` | warning | clamp |
| `compat.zip64` | warning | use Zip64 |
| `compat.zip64-required` | error | abort |

The name rules show **per action** because their tier follows the `--name-*` setting (default `fix`, reported as `info`). Junk removal and same-source deduplication are deliberately `info`: dropping a `.DS_Store` or collapsing a file two overlapping inputs both supplied is not something to fail a build over. A collision is always an `error` — there is no auto-rename option, because choosing which file to rename is the ambiguous resolution that defines the tier — and Zip64 distinguishes `compat.zip64` (used, a warning) from `compat.zip64-required` (needed but disabled by `zip64: never`, an error).

Where a policy could otherwise flip a tier, the two outcomes are modeled as separate rules. A collision is always an error — there is no auto-rename option, because choosing which file to rename is the ambiguous resolution that defines the error tier. Zip64 distinguishes `compat.zip64` (used, a warning) from `compat.zip64-required` (needed but disabled by `zip64: never`, an error).

### Exit codes

The CLI exit codes make this a dependable automation contract:

| Code | Meaning |
|---|---|
| `0` | success — the verb's domain verdict is satisfied |
| `1` | a negative **domain verdict**: the verb ran cleanly but its result is "no" — for `create`, a non-writable plan (a blocking finding, or an existing output without `--overwrite`); for `extract`, a report whose `reportOk` is false (a CRC failure, an unsafe path, or — under `--check-metadata` — a missing/extra entry or SHA mismatch). `--dry-run` honors these, making either a CI gate. |
| `2` | usage error: a malformed flag or value, a missing input path, an archive that cannot be opened, or `extract` without a destination or `--dry-run` |
| `3` | a **scan** runtime fault — a filesystem read failed while walking the source tree |
| `4` | a **write** runtime fault — emitting the archive failed mid-run |
| `5` | a **read** runtime fault — reading or extracting the archive failed mid-run |
| `130` | interrupted (SIGINT) |

Two questions, two answers. Code `1` is a clean run with a negative verdict (a "no"), distinct from the envelope's derived `ok` (which only says no error-tier finding fired). Codes `3`/`4`/`5` are a *thrown* runtime fault, coded by which side of the pipeline failed — so a caller can tell a bad source tree from a bad output path from a bad archive. A single classifier owns the thrown-fault half, so the exit code and the rendered report can never disagree. An operational fault is still folded into the report as an error-tier `Finding` (its fault code in `rule`, `severity: "error"`, the OS cause folded into `message`), so even on failure stdout carries the one report. Without `--json`, a human fault line `zipkit [<code>]: <message>` is also written to stderr; under `--json`, the live fault rides out as a `zipkit[error]:{…}` JSONL record on stderr while the same fault lands as a finding in the final stdout report. Even a pre-verb usage error under `--json` emits a minimal envelope on stdout, so a `--json` caller always parses one report.

## SDK

The `plan → inspect → write` flow is the reason ZipKit is an SDK and not only a CLI: compute the plan, read its `findings`, decide, then write.

```ts
import { ZipKit } from "zipkit";

// Make non-portable names fail the plan instead of being repaired.
const zip = new ZipKit({ policy: { names: { invalidChars: "error", reserved: "error" } } });

// Plan, inspect, then write.
// `plan()` returns the CreateData "plan" payload; `write()`/`create()` return the
// "write" payload (or throw a ZipKitError on an operational fault).
const plan = await zip.plan({ inputs: ["./my-project"], output: "out.zip" });
if (plan.writable) {
  const result = await zip.write(plan);
  console.log(`wrote ${result.metadata?.entries.length} entries (${result.bytes} bytes)`);
} else {
  console.error(plan.findings);
}

// Or plan and write in one call.
await zip.create({ inputs: ["./my-project"], output: "out.zip", overwrite: true });

// Read side: validate (write nothing) or extract. CRC is always checked.
const report = await zip.extract({ archive: "out.zip", dryRun: true, checkMetadata: true });
if (!report.reportOk) console.error(report.findings);

await zip.extract({ archive: "out.zip", dest: "./restored", overwrite: true });
```

The SDK is idiomatic: its methods return the per-verb `data` payloads — `CreateData` from `plan()`/`write()`/`create()`, `ExtractData` from `extract()` — and **throw** `ZipKitError` on an operational fault. The CLI is the layer that wraps a payload in the report envelope and folds a thrown fault into `findings`; the `buildReport` helper is exported for callers who want to produce the same envelope.

The committed export surface is the `ZipKit` class; the data types `ZipKitOptions`, `ZipKitCallOptions`, `ArchiveSpec`, `ArchiveInput`, `ArchivePolicy`, `CompressionPolicy`, `MetadataPolicy`, `FilterRule`, `CreateData`, `PlanSummary`, `PlannedEntry`, `Finding`, `Severity`, `Metadata`, `MetadataEntry`, `MetadataExcluded`, `Transformation`, `UtcTime`, `ExtractSpec`, `ExtractData`, `ExtractEntryResult`, `LogEvent`; the report envelope `Report` with the stderr records `ProgressEvent`/`ErrorEvent`, the `buildReport`/`isOk` helpers, and the `SCHEMA_VERSION` constant; and the errors `ZipKitError`, `ScanError`, `PolicyError`, `WriteError`, `ReadError`, `AbortError` with the type `ZipKitErrorType`.

Progress is observed in real time through an optional `onProgress` hook passed to each verb call (`ZipKitCallOptions`), which receives a `LogEvent` stream as the pipeline works. The hook lives on the per-call options rather than the instance, so each call decides where its events go; with no hook the SDK is silent and writes to no stream. The same stream feeds this hook, the CLI console renderer, and the `--log` JSONL sink — one producer, many sinks.

```ts
const zip = new ZipKit();
await zip.create(
  { inputs: ["./my-project"], output: "out.zip", overwrite: true },
  { onProgress: (event) => console.error(`${event.stage}: ${event.message}`) },
);
```

Cancellation is the other per-call option: an `AbortSignal` on `ZipKitCallOptions` stops any verb — `plan`, `write`, `create`, `extract` — cleanly at its next boundary (a phase edge, a walked entry, a streamed chunk), rejecting with `AbortError`. It is control rather than data, so it lives on the call options beside `onProgress`, not on the spec. A cancelled `create` leaves no archive behind, since the output is renamed into place only after a complete write. The CLI installs this for you: Ctrl-C (`SIGINT`) aborts the run and exits `130`.

```ts
const controller = new AbortController();
const plan = await zip.plan({ inputs: ["./my-project"], output: "out.zip" });
// …decide based on plan.findings, then write under a cancellable signal:
await zip.write(plan, { signal: controller.signal });
```

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
