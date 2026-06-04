# CLI reference

```
zipkit create <inputs...> [options]
```

The CLI exposes one subcommand, `create`, leaving room for a future read/audit subcommand without a breaking change. Flags are grouped by concern, in the order the tool resolves them.

## Source

| Flag | Description |
|---|---|
| `--root <dir>` | Root every input's archive path relative to this directory. Mutually exclusive with `as`/`flatten`. |
| `--wrap` | For a single directory input, keep its name as the top layer instead of flattening its contents to the root. |

## Destination

| Flag | Description |
|---|---|
| `-o, --output <path>` | Output archive path. When omitted, the archive is written beside what is archived (`<dirname>.zip`, `<stem>.zip`, or `<parent>.zip`). |
| `--overwrite` | Overwrite an existing output. |

## Selection

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

## Naming

| Flag | Default | Description |
|---|---|---|
| `--invalid-char <char>` | `_` | Replacement for invalid characters. |

NFC normalization, the other name fixes, and collision detection are unconditional and carry no knob.

## Entry data

| Flag | Default | Description |
|---|---|---|
| `--symlinks <ignore\|preserve\|follow>` | `ignore` | Symlink handling. |
| `--follow-external` | off | Under `follow`, allow links that escape the input tree. |
| `--timestamps <clamp\|preserve>` | `clamp` | Timestamp policy. |
| `--store-ext <list>` | (built-in list) | Comma-separated extensions stored without deflating. |
| `--no-store-ext` | | Deflate everything (clear the store list). |
| `--store-all` | | Store every entry. |
| `--compress-all` | | Deflate every entry. |

The built-in store list (already-compressed formats): `.jpg`, `.png`, `.gif`, `.webp`, `.mp4`, `.mov`, `.mkv`, `.mp3`, `.aac`, `.zip`, `.gz`, `.7z`, `.rar`, `.docx`, `.xlsx`, `.pptx`.

## Companion output

| Flag | Default | Description |
|---|---|---|
| `--metadata` | off | Emit the metadata file (serialized plan plus raw scan data). |
| `--metadata-hash` | off | Include a SHA-256 per file. |
| `--metadata-placement <inside\|sidecar>` | `inside` | Inside the archive at its root, or beside the `.zip`. |

## Container format

| Flag | Default | Description |
|---|---|---|
| `--zip64 <auto\|never\|always>` | `auto` | Zip64 policy. |
| `--deterministic` | off | Reproducible output: entries sorted lexically, a fixed modification time. |

## Diagnostics and control

| Flag | Description |
|---|---|
| `--dry-run` | Compute and render the plan; write nothing. The CLI form of `plan()`. |
| `--strict` | Treat warnings as blocking. |
| `--log <path.jsonl>` | Write the event stream as JSONL. |
| `--quiet` | Suppress console progress. |
| `--verbose` | Include per-entry detail in console progress. |
| `--concurrency <n>` | Maximum concurrent file operations. |
| `--json` | Emit the plan or result as JSON; suppress the human renderer. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | the plan is not writable (a blocking finding, or an existing output without `--overwrite`) |
| `2` | usage error |
| `130` | interrupted (SIGINT) |
