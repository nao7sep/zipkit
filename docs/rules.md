# Rule registry and severity contract

Severity lives in exactly one place — the `RULE_REGISTRY` constant. Rules never write a tier inline; they read it from the registry. The boundary between tiers is a single, tested definition, so a consumer's CI verdict never flips on an unrelated change.

## Classification principle

- **error** — there is no safe, unambiguous automatic resolution; proceeding would corrupt data, lose data, or pick a winner arbitrarily. An error always blocks (`writable = false`), with or without strict gating.
- **warning** — the tool safely auto-fixed the issue, but the finding reflects a portability defect in the source that a careful author might fix upstream. A warning blocks only under strict gating.
- **info** — routine hygiene the tool performs by design; nothing for the consumer to act on. Info never blocks.

The coupling that prevents drift is exact: **error is defined as the tier that blocks unconditionally.** Severity cannot be reclassified without changing observable blocking behavior, which is visible and tested.

## The registry, in pipeline order

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

## Enforcement

Three invariants are tested:

1. Every emitted finding's `rule` exists in the registry.
2. Every finding's `severity` equals the registry tier for that rule (guaranteed by the `finding()` factory, which stamps severity from the registry).
3. Every `error` rule sets `writable = false`, and no `warning` or `info` rule does.

Changing a tier is a breaking change to strict-gating semantics and is recorded as such, never edited casually.
