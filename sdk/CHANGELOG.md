# Changelog

All notable changes to the ZipKit SDK are documented in this file. The desktop app's are in [the app's changelog](../CHANGELOG.md), which also holds the SDK's history up to 0.1.0.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `verify({ archive, manifest })` checks an archive: every entry's CRC-32 and local header, and under `manifest` its embedded manifest (nothing missing or extra, each type, size, CRC-32 and SHA-256 equal). An entry whose data cannot be read is reported on its own.
- `checkRemoval` checks whether the originals an archive was made from can be removed without losing data: the archive is not inside them, it verifies, and a fresh scan still matches it by type, size, modification time and content. What changed is named by its place on disk.
- `onProgress` reports entries and bytes done while writing, verifying and rechecking; `PlanSummary.sourceBytes` is the size of what is archived; each planned entry's `diskPath` says where it is on disk.
- `pathState`, `pathKinds` and `sameFile` tell what is at a path; `createPathClaims` and `pathResources` keep concurrent operations off the same files.
- An archive spec takes `outputDir` and `outputName` beside `output`. An inferred archive name is held to the name rules and fixed like an entry's; a given one is reported, never changed.
- Everything a caller recognizes again carries a stable code or id beside any English text: each finding its `id`, each excluded planned entry its `excludeCode`, an unsupported one its `unsupportedKind`, and one an exclusion pattern left out its `excludedBy` (the pattern's id and text); each built-in exclusion pattern has an `id`. Each planned entry lists its own `nameFixes`. Every type the public signatures use is exported.
- `ZipKitOptions.app` names the calling app, which every manifest then records beside the SDK.
- `DEFAULT_POLICY` and `MANIFEST_DEFAULTS` are the built-in policy, so a caller shows the SDK's defaults instead of restating them.

### Changed

- ZipKit's SDK checks, archives and verifies, and does nothing else: extraction, `list` and `readManifest` are gone.
- A plan is plain data, writer's instructions included, so it is written after a structured clone or a JSON round trip as it would be beside `plan`.
- `create` returns a plan that blocks, such as on an existing output without `overwrite`, as its refusal instead of throwing; `write` returns the plan blocked by `output.exists` when an output appeared since the plan.
- `write` acts on a plan's instructions alone, its output, writability and Zip64 decision included, and refuses a plan whose visible fields disagree with them (`plan.invalid`).
- Every method takes what it is asked to do as its arguments, `verify({ archive, manifest, manifestName })` and `checkRemoval({ spec, archive, removed })` included, and one set of call options (`signal`, `onEvent`, `onProgress`, `onPhysicalSettlement`). An unknown key in either is refused (`request.invalid`, `options.invalid`), never ignored.
- Without hard links (exFAT, FAT), an archive is published by renaming it in once its name is confirmed free, never by copying it into place.
- `path.too-long` measures an entry path against what Windows' 260-character limit leaves once the archive is extracted into a folder named after it.
- One name for each thing: the manifest (`Manifest`, `policy.manifest`), `timeZone`, a path `missing`, the per-entry `crc32` and `sha256`, and each entry's `nameFixes` (`NameFix`). `plan()` returns `PlanData` and `write()` returns `WriteData`.
- Every location is absolute: inputs, `output`, `outputDir`, an archive, and the paths given to `pathState`, `pathKinds`, `pathResources` and `checkRemoval`. A relative one is refused (`spec.invalid`, `options.invalid`, or `path.not-absolute`); the SDK resolves nothing against a working directory.
- Errors are one type, `ZipKitError`, described by its fields: a stable `code` named by cause (`path.missing`, `path.denied`, `io.failed`, `archive.*`, `manifest.*`, `operation.cancelled` and others); a `kind` (`invalid`, `unavailable`, `cancelled` or `internal`) that says what a caller can do; an `effect` (`none` or `unknown`) that says whether the failure may have left output behind; the `subject` path or entry; typed `details`; and the `cause`. `ERROR_CODES` declares every code with its kind, an error serializes to plain data, and `isZipKitError` recognizes that data across process boundaries. Anything unclassified that escapes a verb is reported as `internal.unexpected`; a file that fails or disappears during a write is named by its own path, and `write.failed` is gone.
- The per-call event hook is `onEvent` (was `onProgress`); `onProgress` now carries progress counts. The startup event goes to the first call that listens and carries the I/O timeout, `debug` and the instance policy. A failed call ends with one `fault` event carrying its error as thrown; a cancellation is recorded at `info`.
- The SDK reads no environment variables, writes no log of its own and skips nothing by location: events reach only `onEvent`, and `debug` is an instance option.
- What is left out is one list, `policy.exclusions` (was `junk` and `filters`): each pattern is a glob or a regex with its target, whether case matters, an optional id and an optional note, and every match is an `exclude.pattern` finding. A glob ending in `/` names folders only. The list ZipKit starts with is `DEFAULT_EXCLUSIONS`.
- A symbolic link is reported as `entry.symlink-ignored` or `entry.symlink-preserved` (was `entry.symlink` for both). Verification's rules are in `RULE_REGISTRY`, every one an error, `verify.extra` included.
- The manifest names its format, `format: "zipkit.manifest"`, beside `formatVersion`; a reader refuses a document that names another. Its `writer` is `zipkitsdk` with its version, its `app` the calling app when one is named; each excluded entry carries its `excludeCode`; the time zone is recorded once, as `timeZone`; and exclusion patterns are recorded by id and text, never by note, so rewording a note changes no manifest.
- The SDK is its own workspace package, `zipkitsdk`, in `sdk/`, with its own dependencies and tests, consumed from its TypeScript source with no build. Beside its entry it exports `zipkitsdk/types` (the browser entry: every type with the built-in policy, exclusion patterns and rule registry, for code that loads no Node modules, held by a typecheck against browser libraries) and `zipkitsdk/testing` (the bounded file access and Node's file system as it plugs in, for fault-injection tests).
