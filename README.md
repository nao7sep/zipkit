# ZipKit

A cross-platform ZIP archiver and portability linter/fixer, usable as both a TypeScript SDK and a CLI. It produces archives that are clean across platforms: an archive made on macOS contains nothing a Windows user will trip over, and the reverse.

ZipKit is fundamentally a portability linter with a fixer attached. The compression and container work is the small part; the value is the set of checks and the policy that decides what to do about each one — NFD-decomposed names, Windows-invalid characters, reserved device names, OS junk files, Unix-only attributes, and unknown extra fields.

## How it works

Three layers, with all side effects at the edges:

1. **scan** walks the filesystem and produces raw metadata (read I/O).
2. **plan** is pure: it runs every rule, produces findings, and resolves each into an action. This is the heart of the tool and is unit-tested with synthetic entries.
3. **write** emits the ZIP bytes atomically (write I/O).

A dry run is `scan + plan`; an actual run is `scan + plan + write`. Both share the one pure planning function, so the dry run is faithful to the actual run by construction.

## Quick start

```sh
npm install
npm run build
```

```sh
# Create a clean archive next to a directory
zipkit create ./my-project

# Dry run: compute and render the plan, write nothing (a CI gate)
zipkit create ./my-project --dry-run

# Strict mode: fail the build on any portability defect
zipkit create ./my-project --strict --dry-run
```

## Severity contract and exit codes

Every rule has a fixed tier, decided by one principle and enforced by a single registry (see [docs/rules.md](docs/rules.md)):

- **error** — no safe, unambiguous automatic resolution exists; proceeding would corrupt, lose, or arbitrarily pick. An error always blocks.
- **warning** — the tool safely auto-fixed a portability defect a careful author might fix upstream. A warning blocks only under `--strict`.
- **info** — routine hygiene the tool performs by design. Info never blocks.

The CLI exit codes make this a dependable automation contract:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | the plan is not writable — a blocking finding, or an existing output without `--overwrite`. `--dry-run` honors this, making it a CI gate. |
| `2` | usage error |
| `130` | interrupted (SIGINT) |

`--json` suppresses the human renderer and emits the `Plan` (dry run) or `WriteResult` (actual run) as JSON. Errors always go to stderr, so stdout stays valid JSON.

## CLI

```
zipkit create <inputs...> [options]
```

Flags follow a fixed concern order: source, destination, selection, naming, entry data, companion output, container format, diagnostics. See [docs/cli.md](docs/cli.md) for the full reference. Three behaviors are normative:

- **Interleave is preserved.** `--include`, `--exclude`, `--include-regex`, and `--exclude-regex` append to one shared ordered list as the parser encounters them, so first-match-wins works across mixed flags — an explicit include can rescue a junk-listed file.
- **A trailing slash means directory.** `--exclude 'node_modules/'` targets directories; `--exclude '*.tmp'` targets files and directories.
- **`--dry-run` is the CLI form of calling `plan()`.**

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

The runtime is Node 22.12 or later, ESM.

## License

MIT © Yoshinao Inoguchi
