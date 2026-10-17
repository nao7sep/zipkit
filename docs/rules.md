# Rules, exclusion codes and error codes

Every finding ZipKit reports carries a `rule`, every item it leaves out an `excludeCode`, and every error a `code`. These identifiers are stable: key on them, never on the English messages beside them, which may change. The [SDK guide](sdk.md) shows where each appears.

## Severity

Severity alone decides blocking. An `error` makes a plan unwritable (`writable: false`) and a verification fail; a `warning` and an `info` never block. A caller who wants an issue to block raises it to `error`, for the name rules through the `names` policy.

## Plan rules

In pipeline order. `RULE_REGISTRY` holds the same severities and default dispositions at run time.

| Rule | Severity | What it means | Default |
| --- | --- | --- | --- |
| `path.absolute` | warning | An entry path was absolute; its prefix is stripped | strip prefix |
| `path.traversal` | error | An entry path escapes the archive root (`..`); the entry is left out | abort |
| `path.too-long` | warning | A path component exceeds 255 characters, or the whole path 260, which Windows tools may not open | keep |
| `macos.junk` | info | macOS metadata such as `.DS_Store`, `._*`, `__MACOSX/`, `.Spotlight-V100` | exclude |
| `windows.junk` | info | Windows metadata such as `Thumbs.db`, `desktop.ini`, `$RECYCLE.BIN/` | exclude |
| `linux.junk` | info | Linux metadata such as `.Trash-*/`, `.directory`, `.nfs*` | exclude |
| `entry.symlink` | warning | A symbolic link under `symlinks: "ignore"` | exclude |
| `entry.unsupported` | info | A socket, named pipe or device, or under `follow` a link to nothing a ZIP can hold | exclude |
| `entry.unlisted` | warning | A folder below an input could not be listed: it is archived without its contents | keep without contents |
| `name.nfd` | per `names.nfc` | A name in decomposed Unicode (as macOS writes it), which Windows shows as different characters | normalize to NFC |
| `name.invalid-char` | per `names.invalidChars` | A name holds a character Windows forbids: `< > : " \| ? * \` | substitute |
| `name.control-char` | per `names.controlChars` | A name holds a control character | strip |
| `name.trailing-dot-space` | per `names.trailingDotSpace` | A name ends in a dot or a space, which Windows drops | trim |
| `name.reserved` | per `names.reserved` | A name is a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM0`–`COM9`, `LPT0`–`LPT9` and their superscript-digit forms, with any extension); a `_` is added after the stem | suffix |
| `name.suspicious` | warning | A name holds an invisible or direction-changing character (zero-width space, BOM, bidirectional overrides) | keep |
| `entry.duplicate` | info | The same file reached through two overlapping inputs; one copy is archived | deduplicate |
| `collision.case` | error | Distinct files whose paths differ only by case collide on Windows and macOS | abort |
| `collision.post-fix` | error | Distinct files resolve to the same path, usually after a fix, or one takes the manifest's name | abort |
| `time.pre-1980` | warning | A modification time before 1980, which the ZIP time field cannot hold; clamped | clamp |
| `time.post-2107` | warning | A modification time after 2107; clamped | clamp |
| `output.exists` | error | The archive already exists; set `overwrite` to replace it | overwrite |

A name rule's severity follows its policy action: `fix` repairs the name and reports `info`, `warn` keeps it and reports `warning`, `error` keeps it and reports `error`, `none` reports nothing. `name.suspicious` has no `fix`: those characters are kept by design.

How `name.invalid-char` replaces characters is `names.invalidCharStyle`:

| Style | `How are you???.url` | `a:b` |
| --- | --- | --- |
| `tidy` (default) | `How are you.url` | `a_b` |
| `replace` | `How are you___.url` | `a_b` |
| `fullwidth` | `How are you？？？.url` | `a：b` |
| `remove` | `How are you.url` | `ab` |

## Read rules

Reported by `extract`; each is an `error`.

| Rule | What it means |
| --- | --- |
| `extract.crc-fail` | An entry's CRC-32 does not match its data: the entry is corrupt |
| `extract.sha-mismatch` | An entry's SHA-256 does not match the manifest (`checkMetadata`) |
| `extract.manifest-mismatch` | An entry's type, size or CRC-32 differs from the manifest (`checkMetadata`) |
| `extract.missing` | The manifest lists an entry the archive lacks (`checkMetadata`) |
| `extract.extra` | The archive holds an entry the manifest does not list (`checkMetadata`) |
| `extract.unsafe-path` | An entry would land outside the destination: a `..` path or a link that leads out |

## Exclusion codes

An excluded `PlannedEntry` carries one `excludeCode`:

| Code | Why it was left out |
| --- | --- |
| `junk` | OS junk, by the `junk` preset (`macos.junk`, `windows.junk`, `linux.junk`) |
| `filter` | A `filters` rule matched; a matched folder is left out with everything in it |
| `empty-dir` | An empty folder under `emptyDirs: "prune"` |
| `empty-file` | An empty file under `emptyFiles: "skip"` |
| `duplicate` | The same file through another input, which is archived (`entry.duplicate`) |
| `path-traversal` | Its path escapes the archive root (`path.traversal`) |
| `symlink` | A link under `symlinks: "ignore"` (`entry.symlink`) |
| `unsupported` | Something a ZIP cannot hold (`entry.unsupported`) |

## Error codes

Each error's `errorType` says which class it is; its `code` says what happened.

| Code | Class | What happened |
| --- | --- | --- |
| `spec.invalid` | `PolicyError` | The archive spec is malformed |
| `policy.invalid` | `PolicyError` | The policy is malformed |
| `options.invalid` | `PolicyError` | An instance option (`concurrency`, `chunkSize`, `ioTimeoutMs`, `logDir`, `debug`, `skipPaths`) is invalid |
| `output.ambiguous` | `PolicyError` | No archive path can be inferred: inputs in different folders and no `output`, `outputDir` or `outputName` |
| `input.prefix-collision` | `PolicyError` | Two inputs would share a top-level folder in the archive |
| `plan.not-exportable` | `PolicyError` | `exportPlan` was given an object `plan` did not return |
| `plan.transfer-invalid` | `PolicyError` | `importPlan` was given something `exportPlan` did not make |
| `scan.input-missing` | `ScanError` | An input does not exist or cannot be read |
| `scan.output-is-input` | `ScanError` | The archive path is one of the inputs |
| `scan.output-stat-failed` | `ScanError` | The archive path cannot be checked |
| `scan.stat-failed` | `ScanError` | An item cannot be read during the scan |
| `scan.walk-failed` | `ScanError` | An input folder cannot be listed |
| `write.not-writable` | `WriteError` | The plan has blocking findings |
| `write.no-internals` | `WriteError` | The plan is a copy, not the object `plan` returned (use `exportPlan`/`importPlan` to move one) |
| `write.source-changed` | `WriteError` | A file changed while it was archived; its archive `path` is on the error |
| `write.read-failed` | `WriteError` | A file could not be read while archived |
| `write.durability` | `WriteError` | The archive was published but its save could not be confirmed on disk |
| `write.failed` | `WriteError` | Writing the archive failed |
| `read.open-failed` | `ReadError` | The archive cannot be opened |
| `read.not-zip` | `ReadError` | The file is not a ZIP |
| `read.malformed` | `ReadError` | The archive's structure is damaged |
| `read.unsupported-method` | `ReadError` | An entry uses a compression method other than Store or Deflate |
| `read.inflate-failed` | `ReadError` | An entry's compressed data is corrupt |
| `read.size-mismatch` | `ReadError` | An entry's data is not the size its header declares |
| `read.entry-too-large` | `ReadError` | A link entry's target is larger than a link can be |
| `read.target-collision` | `ReadError` | Two entries would be written to the same place |
| `read.unsafe-path` | `ReadError` | An entry escapes the destination under `onUnsafe: "abort"` |
| `read.no-dest` | `ReadError` | `extract` was given no `dest` and no `dryRun` |
| `read.write-failed` | `ReadError` | An extracted file could not be written |
| `read.manifest-missing` | `ReadError` | `checkMetadata` or `readManifest` found no manifest |
| `read.manifest-invalid` | `ReadError` | The manifest is not valid |
| `read.manifest-newer` | `ReadError` | A newer ZipKit wrote the manifest |
| `aborted` | `AbortError` | The `signal` aborted |
| `io.stalled` | `StallError` | A file operation did not finish within `ioTimeoutMs` |
