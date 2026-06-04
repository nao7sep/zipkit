# ZipKit

A cross-platform ZIP archiver and portability linter/fixer, usable as both a TypeScript SDK and a CLI. It produces archives that are clean across platforms: an archive made on macOS contains nothing a Windows user will trip over, and the reverse.

ZipKit is fundamentally a portability linter with a fixer attached. The compression and container work is the small part; the value is the set of checks and the policy that decides what to do about each one — NFD-decomposed names, Windows-invalid characters, reserved device names, OS junk files, Unix-only attributes, and unknown extra fields.

## How it works

Three layers, with all side effects at the edges:

1. **scan** walks the filesystem and produces raw metadata (read I/O).
2. **plan** is pure: it runs every rule, produces findings, and resolves each into an action. This is the heart of the tool and is unit-tested with synthetic entries.
3. **write** emits the ZIP bytes atomically (write I/O).

A dry run is `scan + plan`; an actual run is `scan + plan + write`. Both share the one pure planning function, so the dry run is faithful to the actual run by construction.

## Install

```sh
npm install
npm run build
```

The runtime is Node 22.12 or later, ESM.

```sh
# Create a clean archive next to a directory
zipkit create ./my-project

# Dry run: compute and render the plan, write nothing (a CI gate)
zipkit create ./my-project --dry-run

# Strict mode: fail the build on any portability defect
zipkit create ./my-project --strict --dry-run
```

## CLI

```
zipkit create <inputs...> [options]
```

The CLI exposes one subcommand, `create`, leaving room for a future read/audit subcommand without a breaking change. Flags are grouped by concern, in the order the tool resolves them. Three behaviors are normative:

- **Interleave is preserved.** `--include`, `--exclude`, `--include-regex`, and `--exclude-regex` append to one shared ordered list as the parser encounters them, so first-match-wins works across mixed flags — an explicit include can rescue a junk-listed file.
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
| `--overwrite` | Overwrite an existing output. |

### Selection

| Flag | Default | Description |
|---|---|---|
| `--junk <builtin\|none>` | `builtin` | Built-in bidirectional junk preset. |
| `--include <pattern>` | | Include glob (repeatable, ordered). |
| `--exclude <pattern>` | | Exclude glob (repeatable, ordered). |
| `--include-regex <pattern>` | | Include regex (repeatable, ordered). |
| `--exclude-regex <pattern>` | | Exclude regex (repeatable, ordered). |
| `--skip-empty-files` | off | Drop zero-byte files. |
| `--empty-dirs <keep\|prune>` | `keep` | Empty-directory handling. |
| `--empty-dir-def <strict\|recursive>` | `recursive` | What counts as empty. |

All four include/exclude flags append to one shared ordered list in command-line order; first-match-wins. A trailing slash on a glob targets directories.

#### Built-in junk preset

`--junk builtin` (the default) drops these OS-generated files bidirectionally. They report as info findings (`macos.junk` / `windows.junk`) and never block, even under `--strict`. An explicit `--include` can rescue any of them, since first-match-wins on the shared ordered list. `--junk none` disables the preset.

- **macOS:** `.DS_Store`, `__MACOSX/`, `._*` (AppleDouble files), `Icon\r` (custom folder icon), `.Spotlight-V100`, `.Trashes`, `.fseventsd`
- **Windows:** `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `$RECYCLE.BIN/`, `System Volume Information/`

### Naming

| Flag | Default | Description |
|---|---|---|
| `--invalid-char <char>` | `_` | Replacement for invalid characters. |

NFC normalization, the other name fixes, and collision detection are unconditional and carry no knob.

### Entry data

| Flag | Default | Description |
|---|---|---|
| `--symlinks <ignore\|preserve\|follow>` | `ignore` | Symlink handling. `ignore` drops the link (a warning, visible in the plan); `preserve` keeps it as a Unix link entry — it is *not* replaced by its target, but Windows extracts such entries as text files, breaking the clean-byte guarantee; `follow` replaces each link with the real file or directory it points to. Windows `.lnk` shortcut files are ordinary files, not symlinks, and are archived as-is regardless of this flag. |
| `--follow-external` | off | Under `follow`, allow links that escape the input tree. |
| `--timestamps <clamp\|preserve>` | `clamp` | Timestamp policy. |
| `--store-ext <list>` | (built-in list) | Comma-separated extensions stored without deflating. |
| `--no-store-ext` | | Deflate everything (clear the store list). |
| `--store-all` | | Store every entry. |
| `--compress-all` | | Deflate every entry. |

The store list names already-compressed formats, where attempting deflate is wasted effort. Files outside the list are deflated, and any entry whose deflate does not shrink falls back to store — so the list is a CPU optimization, never a correctness setting. Borderline formats such as PDF are deliberately left off so `auto` keeps the win on the ones that do compress. Built-in list: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.heic`, `.mp4`, `.mov`, `.mkv`, `.webm`, `.mp3`, `.aac`, `.m4a`, `.flac`, `.zip`, `.gz`, `.7z`, `.rar`, `.docx`, `.xlsx`, `.pptx`, `.woff2`.

### Companion output

| Flag | Default | Description |
|---|---|---|
| `--metadata` | off | Emit the metadata file (serialized plan plus raw scan data). |
| `--metadata-hash` | off | Include a SHA-256 per file. |
| `--metadata-name <name>` | `_metadata.json` | Metadata file name. Must be a single path component (no slashes). |
| `--metadata-placement <inside\|sidecar>` | `inside` | Inside the archive at its root, or beside the `.zip`. |

The metadata file is a JSON record of the run: a header (`tool`, `version`, `createdUtc`, the resolved `policy`, the plan `summary`, and aggregate `totals` of uncompressed and compressed bytes); one record per written entry (`archivePath`, `originalPath`, `sourcePath`, `type`, `method`, `size` and `compressedSize`, `crc32`, optional `sha256`, `mode`, `mtimeNs`/`birthtimeNs`, `linkTarget` for preserved symlinks, and the `transformations` applied); the list of `excluded` entries with their `reason`; and all `findings`. It never stores absolute source paths, and under `--deterministic` the volatile time fields are omitted so the record is reproducible.

### Container format

| Flag | Default | Description |
|---|---|---|
| `--zip64 <auto\|never\|always>` | `auto` | Zip64 policy. |
| `--deterministic` | off | Reproducible output: entries sorted lexically, a fixed modification time. |

### Diagnostics and control

| Flag | Description |
|---|---|
| `--dry-run` | Compute and render the plan; write nothing. The CLI form of `plan()`. |
| `--strict` | Treat warnings as blocking. |
| `--log <path.jsonl>` | Write the event stream as JSONL. |
| `--quiet` | Suppress console progress. |
| `--verbose` | Include per-entry detail in console progress. |
| `--concurrency <n>` | Maximum concurrent file operations. Defaults to the available CPU count, bounded to 4–16. |
| `--json` | Emit the plan or result as JSON; suppress the human renderer. |

`--json` suppresses the human renderer and emits the `Plan` (dry run) or `WriteResult` (actual run) as JSON. Errors always go to stderr, so stdout stays valid JSON.

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
| `1` | the run did not produce an archive — a non-writable plan (a blocking finding, or an existing output without `--overwrite`), or a write failure. `--dry-run` honors the non-writable case, making it a CI gate. |
| `2` | usage error, including a missing input path |
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
```

The committed export surface is the `ZipKit` class; the types `ZipKitOptions`, `ArchiveSpec`, `ArchiveInput`, `ArchivePolicy`, `CompressionPolicy`, `MetadataPolicy`, `FilterRule`, `Plan`, `PlanSummary`, `PlannedEntry`, `Finding`, `Severity`, `WriteResult`, `LogEvent`; and the errors `ZipKitError`, `ScanError`, `PolicyError`, `WriteError`, `AbortError` with the type `ZipKitErrorType`.

Progress is observed in real time through the optional `logger` callback, which receives a `LogEvent` stream as the pipeline works. The same stream feeds the SDK callback, the CLI console renderer, and the `--log` JSONL sink.

## The clean-byte guarantee

Archives carry the UTF-8 name flag, a FAT host byte (no Unix mode leaks), and a zero-length extra field — with two exceptions: the Zip64 extra when genuinely needed, and the Info-ZIP extended-timestamp extra only under timestamp preservation. Compression is Deflate via the platform `zlib`, with a store fallback when deflate does not shrink and store for already-compressed extensions. Output is atomic: a temporary file is written in the same directory, then renamed.

## Scope

v1 is creation of clean archives from a source tree. Out of scope: reading, auditing, or repairing existing archives; encryption; compression methods beyond Store and Deflate; multi-volume or split archives; and streaming of individual large files via data descriptors.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/
npm test            # vitest
```

## License

MIT © Yoshinao Inoguchi
