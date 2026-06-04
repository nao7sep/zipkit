# Manual verification

A record of the standalone verification pass over the built CLI and SDK. Every
scenario below was exercised against the real `dist/` build over a synthetic
fixture tree, and every archive was read back with independent readers to
confirm round-trips. Results are reported as observed.

## Environment

| | |
|---|---|
| ZipKit | 0.1.0 |
| Platform | Darwin 25.5.0 arm64 (macOS, APFS) |
| Node | v26.0.0 |
| Independent readers | Python 3.14.5 `zipfile`, `ditto` (Finder's engine), `bsdtar` (libarchive), Info-ZIP `unzip` 6.00 |

## Method

A single fixture tree (35 files, 22 directories, 4 symlinks) was built to
exercise every rule family at once: compressible and already-compressed
content; empty files; empty and nested-empty directories; macOS and Windows
junk (files and directories); reserved device names; Windows-invalid
characters; a control character; trailing dot/space; an NFD file and an NFD
directory; a zero-width character; pre-1980 and post-2107 modification times;
internal/external/cyclic symlinks; a > 260-character path; and case- and
substitution-collision inputs. 36 archives were produced across the parameter
matrix. Archives were validated by extracting with `ditto`/`bsdtar`/`zipfile`
and byte-comparing content against the source, by Python `zipfile.testzip()`
(which validates every entry's CRC-32), and by parsing the raw bytes for the
container contract.

## Round-trip and byte contract

| Check | Result |
|---|---|
| Every entry's CRC-32 validates (`zipfile.testzip()`) | PASS — `None` (all valid) |
| Content byte-identical after extract (stable and renamed files) | PASS — all `cmp` matches, including the NFD→NFC renamed file |
| General-purpose flag bit 11 (UTF-8) set on every entry | PASS |
| Version-made-by host byte 0 (FAT) on every non-symlink entry | PASS |
| Extra-field length 0 under default (clamp) timestamps | PASS |
| Deterministic output byte-identical across runs | PASS — `cmp` identical |

## Cross-tool compatibility

| Reader | Default archive | Zip64 (`--zip64 always`) archive |
|---|---|---|
| Python `zipfile` | extracts, all CRCs valid | extracts, all CRCs valid |
| `ditto` (Finder) | extracts cleanly | extracts cleanly |
| `bsdtar` (libarchive) | extracts cleanly | — |
| Info-ZIP `unzip` 6.00 (2009) | **fails** on UTF-8 names ("write error") | — |

The legacy `/usr/bin/unzip` (Info-ZIP 6.00, 2009) raises a write error on
UTF-8 filenames; the archive itself is well-formed, confirmed by three
independent strict readers extracting it without error. This is an Info-ZIP
limitation, not a defect in the output.

## Selection (§10.1, §10.9)

| Scenario | Result |
|---|---|
| Built-in junk excluded (macOS ×5, Windows ×2) with `macos.junk`/`windows.junk` info findings | PASS — excluded, info tier, non-blocking |
| `--junk none` keeps junk files | PASS |
| User `--include` rescues a junk-listed file (user rules > junk preset) | PASS — `.DS_Store` present |
| `--exclude` glob (file) | PASS — `*.log` excluded |
| Include/exclude interleave across mixed flags (first-match-wins) | PASS — earlier `--include` rescued a later `--exclude` |
| Trailing-slash glob targets directories (subtree pruned) | PASS — `media/` subtree pruned |
| `--exclude-regex` | PASS — `\.jpg$` excluded |
| `--skip-empty-files` drops zero-byte files; emptied directory becomes an empty-dir entry | PASS |
| Empty directories: `keep`+`recursive` (leaf only), `keep`+`strict` (every node), `prune` (none) | PASS — all three distinct and correct |

## Naming (§10.2)

| Scenario | Result |
|---|---|
| NFD → NFC normalization (`name.nfd`), file and directory | PASS — `café.txt` is NFC; NFD directory normalized |
| Windows-invalid characters substituted (`name.invalid-char`) | PASS — `a_b_c.txt`, `pipe_x.txt`, `star_x.txt`, `quote_x.txt` |
| `--invalid-char` custom replacement | PASS — `a#b#c.txt` |
| Backslash normalized to a path separator | PASS — `back\slash.txt` → `back/slash.txt` |
| Control characters stripped (`name.control-char`) | PASS — `ctrlbell.txt` |
| Trailing dot/space trimmed (`name.trailing-dot-space`) | PASS — `trailingdot`, `trailingspace` |
| Reserved device names suffixed (`name.reserved`) | PASS — `CON_.txt`, `NUL_`, `COM1_.dat`, `aux_` |
| Zero-width/suspicious characters flagged but kept (`name.suspicious`) | PASS — character retained |
| Over-length path warned (`path.too-long`) | PASS — > 260-char path flagged, kept |
| Case collision between distinct sources is an error (`collision.case`) | PASS — not writable, exit 1 |
| Substitution-induced collision is an error (`collision.post-fix`) | PASS — not writable, exit 1 |

## Entry data (§10.6–§10.8)

| Scenario | Result |
|---|---|
| `--symlinks ignore` (default): symlinks excluded with `entry.symlink` warning | PASS — all 4 excluded |
| `--symlinks preserve`: Unix host byte (3) and link mode only on symlinks; FAT (0) elsewhere | PASS — `S_ISLNK`, mode `0120755`, target stored; others host 0 |
| `--symlinks follow`: internal file and directory dereferenced; external link skipped (guard) | PASS |
| `--symlinks follow --follow-external`: external link followed | PASS — target content stored |
| Compression `auto`: already-compressed extensions stored, others deflated | PASS — `.jpg`/`.zip` store, `.txt` deflate |
| `--store-all` / `--compress-all` / `--store-ext` / `--no-store-ext` | PASS — methods as specified |
| Store fallback when deflate does not shrink (incompressible content) | PASS — random content stays stored under `--compress-all` |
| `--timestamps preserve`: extended-timestamp extra (`0x5455`) written in range | PASS |
| Pre-1980 time: DOS floored to 1980-01-01 (`time.pre-1980`), UT carries the real time | PASS |
| Post-2107 time: DOS clamped to 2107-12-31 (`time.post-2107`), no crash | PASS |
| Time beyond the UT field's range (> 2038): extended-timestamp extra omitted | PASS |

## Companion output (§10.10)

| Scenario | Result |
|---|---|
| `--metadata` inside: entry at the archive root with the serialized plan and scan data | PASS |
| `--metadata-hash`: per-file SHA-256 alongside CRC-32 | PASS |
| Metadata header carries tool, version, `createdUtc` (ns + ISO), policy, summary, findings | PASS |
| Metadata stores no absolute source path | PASS |
| `--metadata-placement sidecar`: written beside the `.zip`, not inside it | PASS |
| Volatile fields omitted under `--deterministic` | PASS — `createdUtc` and per-entry times absent |

## Container format (§11)

| Scenario | Result |
|---|---|
| `--zip64 always`: Zip64 end record + locator present; archive round-trips | PASS — `testzip` valid, `ditto` extracts |
| `--zip64 never` on a 32-bit-representable tree: no error | PASS — exit 0 |
| `--deterministic`: entries sorted, fixed time, byte-identical across runs | PASS |

## Diagnostics, gating, and control (§7, §8)

| Scenario | Result |
|---|---|
| `--dry-run` writes nothing and honors `writable` as a CI gate | PASS |
| `--strict`: warnings block (not writable); clean subtree stays writable | PASS — exit 1 vs 0 |
| `--json`: emits the `WriteResult`/`Plan`; the absolute-source-path carrier is never serialized | PASS — only `plan.output` is absolute |
| `--log <path.jsonl>`: one JSON event per line across scan/plan/write | PASS |
| Bad `--log` path | PASS — clean error, exit 2, no crash |
| `--concurrency 1` and `16` | PASS — both round-trip |
| Output resolution: single dir → `<dirname>.zip`; single file → `<stem>.zip`; same parent → `<parent>.zip` | PASS |
| Output resolution: inputs in different parents → error, no fallback | PASS — exit 2, clear message |
| Overwrite gate: existing output without `--overwrite` refused; allowed with it | PASS — exit 1 vs 0 |

## Exit codes (§7)

| Scenario | Code | Result |
|---|---|---|
| Successful create | 0 | PASS |
| Plan not writable (collision, or existing output without overwrite) | 1 | PASS |
| Usage error (no inputs, invalid enum, invalid regex, bad log path) | 2 | PASS |

## SDK surface (§6)

| Scenario | Result |
|---|---|
| `plan()` → inspect `findings`/`writable` → `write(plan)` | PASS — writes the inspected plan |
| Collision plan → `write()` throws `WriteError` (`write.not-writable`) | PASS |
| Empty inputs → `PolicyError` | PASS |
| Pre-aborted `signal` → `AbortError` (`errorType: "abort"`) | PASS |

## Source / arcname (§10.4–§10.5)

| Scenario | Result |
|---|---|
| `--root`: archive paths relative to the root directory | PASS |
| `--wrap`: single directory keeps its name as the top layer | PASS — vs flattened to root without it |
| Degenerate `as` (empty, slash-only, dot-only) | PASS — rejected with `PolicyError` |

## Summary

Every documented parameter and rule family was exercised against the built CLI
and SDK over a single comprehensive fixture tree. All archives round-tripped
through three independent strict readers with valid CRCs and byte-identical
content, and the byte-level container contract held in every case (UTF-8 flag,
FAT host byte, zero extra fields except the deliberate Zip64 and
extended-timestamp exceptions, Unix host byte only for preserved symlinks). No
defects were found during this pass.
