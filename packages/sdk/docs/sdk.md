# ZipKit SDK

The SDK makes ZIP archives that open cleanly on any system and reads them back. It is the library the ZipKit desktop app and the `zipkit` command are built on, and it serves any other app through one entry point:

```ts
import { ZipKit } from "zipkit";
```

It is ESM for Node.js 22.12 or later, ships JavaScript with type declarations, reads no environment variables, prints nothing, and writes nothing outside the paths you give it. Every rule it applies, every reason it leaves something out and every error code is listed in [rules.md](rules.md).

- [Making an archive](#making-an-archive)
- [Reading an archive](#reading-an-archive)
- [Before removing the originals](#before-removing-the-originals)
- [Events, progress and cancellation](#events-progress-and-cancellation)
- [Errors](#errors)
- [Several operations at once](#several-operations-at-once)
- [Reference](#reference)

## Making an archive

An archive is made in two steps: `plan` scans the inputs and decides everything, then `write` writes exactly that plan. Between them you can show the user what will happen, and refuse when something blocks.

```ts
import { ZipKit } from "zipkit";

const zip = new ZipKit();
const plan = await zip.plan({ inputs: ["/Users/me/Projects/site"] });

for (const finding of plan.findings) {
  console.log(finding.severity, finding.rule, finding.path, finding.message);
}
if (plan.writable) {
  const written = await zip.write(plan);
  console.log(`${written.output}: ${written.bytes} bytes`);
}
```

`create(spec)` does both in one call and throws `WriteError` (`write.not-writable`) when the plan blocks.

### Where the archive goes

Give the full path as `output`, or a folder and a name as `outputDir` and `outputName`, or nothing:

| Spec | Archive |
| --- | --- |
| `{ inputs: ["/a/site"] }` | `/a/site.zip` |
| `{ inputs: ["/a/notes.md"] }` | `/a/notes.zip` |
| `{ inputs: ["/a/x", "/a/y"] }` | `/a/a.zip`, named after the folder they share |
| `{ inputs: ["/a/site"], outputDir: "/out" }` | `/out/site.zip` |
| `{ inputs: ["/a/site"], outputName: "delivery" }` | `/a/delivery.zip` |
| `{ inputs: ["/a/site"], output: "/out/x.zip" }` | `/out/x.zip` |

`.zip` is added once when the name lacks it, and an input already named `foo.zip` gives `foo.zip.zip`, never itself. Inputs in different folders need an `output`, an `outputDir` or an `outputName` (`output.ambiguous`). An existing archive blocks the plan with `output.exists` unless `overwrite: true`.

### What goes in

A single folder input has its contents at the archive's root; several inputs each keep their own name as a top-level folder. The policy decides the rest; every field is optional and merges over the defaults, per call or for the instance:

```ts
const zip = new ZipKit({ policy: { symlinks: "preserve" } });
await zip.plan({
  inputs: ["/a/site"],
  policy: {
    filters: [{ pattern: "node_modules/", match: "glob", target: "dir" }],
    names: { invalidChars: "error" },
    metadata: { hash: false },
  },
});
```

| Policy field | Default | Values |
| --- | --- | --- |
| `junk` | `"builtin"` | `"builtin"` leaves out OS junk (`.DS_Store`, `Thumbs.db`, …); `"none"` keeps it |
| `filters` | `[]` | `{ pattern, match: "glob" \| "regex" \| "literal", target: "file" \| "dir" \| "both" }`; every rule excludes |
| `emptyFiles` | `"keep"` | `"skip"` leaves empty files out |
| `emptyDirs` | `"keep"` | `"prune"` leaves empty folders out |
| `names.nfc`, `names.invalidChars`, `names.controlChars`, `names.trailingDotSpace`, `names.reserved` | `"fix"` | `"fix"`, `"warn"`, `"error"` (blocks), `"none"` |
| `names.invalidCharStyle` | `"tidy"` | `"tidy"`, `"replace"`, `"fullwidth"`, `"remove"` |
| `names.invalidCharReplacement` | `"_"` | the character `tidy` and `replace` put in |
| `names.suspicious` | `"warn"` | `"warn"`, `"error"`, `"none"` |
| `symlinks` | `"ignore"` | `"ignore"` leaves links out, `"preserve"` stores the link, `"follow"` stores what it points to |
| `followExternal` | `false` | under `follow`, whether a link may lead outside its input |
| `timezone` | the host's | the IANA zone of the ZIP's local-time field |
| `compression.level` | `6` | Deflate level 0–9 |
| `compression.stored` / `store` | `"builtin"` / `[]` | extensions written uncompressed (already-compressed formats by default) |
| `metadata` | `{ name: "zipkit.json", hash: true }` | the embedded manifest, or `false` for none |

### The plan

`plan` returns a `PlanData`:

- `output` — the archive's absolute path.
- `writable` — false while any finding is an `error`.
- `summary` — counts (`total`, `included`, `excluded`, `renamed`, `warnings`, `errors`), `zip64`, and `sourceBytes`, the size of what is archived as on disk.
- `findings` — every finding, each with a `rule`, a `severity`, the `path` it concerns, an English `message` and, for a fix, `fix.to`.
- `entries` — every item found, with its `archivePath`, the `originalPath` before any fix, its `diskPath`, its `type`, its compression `method`, whether it is `excluded` and, when it is, a stable `excludeCode` beside an English `excludeReason`.

Key on `rule` and `excludeCode`, never on the English text. A plan is safe to inspect and `JSON.stringify`, but only the object `plan` returned can be written: its instructions to the writer ride on it out of band. To hand a plan to another process, `exportPlan(plan)` packages it for a structured clone and `importPlan(transfer)` makes it writable on the other side.

## Reading an archive

`extract` verifies every entry's CRC-32 and, unless `dryRun` is set, writes the verified entries to `dest`. With `checkMetadata` it also checks the archive against its embedded manifest: every entry it lists is there, nothing else is, and each SHA-256 matches.

```ts
const result = await zip.extract({ archive: "/a/site.zip", dryRun: true, checkMetadata: true });
if (!result.reportOk) console.log(result.findings, result.missing, result.extra);

await zip.extract({ archive: "/a/site.zip", dest: "/tmp/site" });
```

A dry run works on any ZIP. Writing restores modification times (`timestamps: "none"` skips that), never writes outside `dest` (an entry whose path escapes it is skipped, or with `onUnsafe: "abort"` stops the run), and never replaces an existing file unless `overwrite` is set. On Windows a name Windows cannot hold is written under a safe name, reported on the entry's `outputPath`.

To look without verifying:

```ts
const listing = await zip.list("/a/site.zip");      // entries from the central directory
const manifest = await zip.readManifest("/a/site.zip"); // the embedded zipkit.json, whole
```

`readManifest` holds the whole document in memory; to check a very large archive against its manifest, use `extract` with `checkMetadata`, which streams it.

## Before removing the originals

An app that deletes or trashes the files it archived should first ask whether that can lose data:

```ts
const check = await zip.checkRemoval({ inputs }, archive, { fingerprint });
if (check.refusal === null) {
  // safe: the archive verifies and holds the inputs exactly as they are now
} else {
  console.log(check.refusal.reason); // "replaced", "inside", "verify-failed", "changed" or "error"
}
```

It checks in order that the archive is the one you made (when you pass its `fingerprint` from `pathState`), that it does not sit inside an input, that it verifies against its manifest, and that a fresh scan of the inputs still matches the manifest (`changed` carries the `comparison`: what was added, is missing, changed or could not be read). A check that cannot finish, on a stalled drive say, refuses with its `step` and `error` rather than throwing. Pass inputs an earlier partial removal already took as `removed`, so what the archive holds from them is not counted as missing. ZipKit removes nothing itself; the Trash and permanent deletion are the app's.

`unarchived(plan)` says what the removal would take without a copy in the archive: the items left out (`excluded`, each with its `diskPath`; a duplicate is not one) and the folders that could not be read (`unlisted`). Show it before asking the user to confirm.

`compareSources(spec, archive)` is the comparison on its own. `pathState(path)` says whether a file is there, gone or out of reach, with a fingerprint; `sameFile(a, b)` tells a file changed in place from another file put in its place. `classify(paths)` says what each path is: a directory, a file, something else, missing or unavailable.

## Events, progress and cancellation

Every verb takes per-call options:

```ts
const controller = new AbortController();
await zip.create(spec, {
  signal: controller.signal,
  onEvent: (event) => console.log(event.time, event.event, event.message),
  onProgress: ({ entriesDone, entriesTotal, bytesDone, bytesTotal }) => {
    bar.update(bytesTotal > 0 ? bytesDone / bytesTotal : entriesDone / Math.max(1, entriesTotal));
  },
});
```

- `onEvent` receives the structured event stream: `scan.start`, `plan.done`, `entry.flagged`, `write.done`, `extract.done`, `fault` and the rest, each with `stage`, `level`, `time` and `message`. `debug` events (one per entry) arrive only when the instance is built with `debug: true`.
- `onProgress` receives counts during `write`, `create` and `extract`: at the start, at most every 100 ms, and at the end.
- `signal` cancels at the next boundary and rejects with `AbortError`; a cancelled write leaves no archive behind.

Neither hook can break the verb: what it throws is ignored. With `logDir` the instance also keeps a session log, one JSON Lines file per instance, and each result's `log` names it.

## Errors

Every failure is a `ZipKitError` subclass with a stable `code` and an `errorType` to branch on:

| Class | `errorType` | When |
| --- | --- | --- |
| `PolicyError` | `policy` | The spec, policy or options are invalid |
| `ScanError` | `scan` | An input cannot be read |
| `WriteError` | `write` | Writing failed, or the plan is not writable |
| `ReadError` | `read` | The archive cannot be read or extracted |
| `AbortError` | `abort` | The `signal` aborted |
| `StallError` | `stall` | A file operation did not finish within `ioTimeoutMs` (30 s by default): a dropped network share or a removed drive. It names the `path`; when `committing`, the archive may still appear |

A plan that blocks is not an error: `writable` is false and the findings say why. The codes are listed in [rules.md](rules.md#error-codes).

## Several operations at once

One `ZipKit` instance can run any number of calls at once; `concurrency` bounds the file operations each call keeps in flight. An app running several jobs that may touch the same files can reserve them:

```ts
const claims = createPathClaims();
const uses = (await zip.pathResources([output])).map((r) => ({ ...r, mode: "change" as const }));
const claim = claims.claim(uses); // null when another job holds an overlapping path
try { /* write */ } finally { claim?.release(); }
```

Claims compare physical files, so a link, a folder alias or a name that differs only in case on a case-insensitive volume is caught.

## Reference

### `new ZipKit(options?)`

| Option | Default | |
| --- | --- | --- |
| `policy` | defaults | Merged under each call's `spec.policy` |
| `concurrency` | 4–16, by CPU | File operations in flight per call |
| `chunkSize` | 65536 | Bytes per streamed read and write |
| `ioTimeoutMs` | 30000 | Per-operation budget before a `StallError` |
| `logDir` | none | Folder for the session log |
| `debug` | `false` | Whether `debug` events are emitted |
| `skipPaths` | `[]` | Folders every scan leaves out, such as the app's own data |

### Methods

| Method | Returns |
| --- | --- |
| `plan(spec, options?)` | `PlanData` |
| `write(plan, options?)` | `WriteData`: `output`, `bytes`, `zip64`, `summary`, `findings`, `metadata` |
| `create(spec, options?)` | `WriteData` |
| `extract(spec, options?)` | `ExtractData` |
| `list(archive, { timeZone?, signal? })` | `ArchiveListing` |
| `readManifest(archive, { name?, signal? })` | `Metadata` |
| `checkRemoval(spec, archive, { removed?, fingerprint?, ... })` | `RemovalCheck` |
| `compareSources(spec, archive, options?)` | `SourceComparison` |
| `pathState(path, { signal? })` | `PathState` |
| `classify(paths, { signal? })` | `PathEntry[]` |
| `pathResources(paths, { signal? })` | `PathResource[]` |
| `volume(signal?)` | the SDK's bounded file access, for a caller that must look at the same volumes |

### Entries

| Entry | |
| --- | --- |
| `zipkit` | Everything on this page |
| `zipkit/types` | The types alone, for code that must not load Node modules, such as a browser window showing results |
| `zipkit/testing` | `Volume`, `nodeFileSystem` and `FileSystemPort`, for tests that make the SDK meet a failing disk: build a `Volume` over a port whose calls fail or never answer, and return it from an overridden `ZipKit.volume` |

### Functions and constants

`exportPlan`, `importPlan`, `unarchived`, `sameFile`, `createPathClaims`, `machineTimeZone`, `RULE_REGISTRY` (every plan rule with its severity and default disposition), `VERSION`.

Every type these use is exported from the same entry; their declarations carry the full documentation.
