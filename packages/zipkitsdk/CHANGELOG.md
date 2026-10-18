# Changelog

All notable changes to the ZipKit SDK and the `zipkit` command are documented in this file. The desktop app's are in [the app's changelog](../../CHANGELOG.md), which also holds the SDK's history up to 0.1.0.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `checkRemoval` checks whether the originals an archive was made from can be removed without losing data; `unarchived(plan)` names what that removal would take without a copy.
- `onProgress` reports entries and bytes done during a write or a read; `PlanSummary.sourceBytes` is the size of what is archived; each planned entry's `diskPath` says where it is on disk.
- `list` reads an archive's entries and `readManifest` its embedded manifest; `pathState`, `classify` and `sameFile` tell what is at a path; `exportPlan`/`importPlan` hand a plan to another process; `createPathClaims` and `pathResources` keep concurrent operations off the same files.
- An archive spec takes `outputDir` and `outputName` beside `output`.
- Every excluded planned entry carries a stable `excludeCode` beside its English reason, and every type the public signatures use is exported, with `machineTimeZone`.

### Changed

- The per-call event hook is `onEvent` (was `onProgress`); `onProgress` now carries progress counts.
- The SDK reads no environment variables and keeps no log of its own: an instance writes a session log only into a given `logDir` (the `sessionLog` option and `ZIPKIT_LOG_DIR` are gone), `debug` is an instance option, and folders to leave out of every scan are passed as `skipPaths`. ZipKit's data folder stays out of the app's scans that way.
- The SDK is its own workspace package, `zipkitsdk`, in `packages/zipkitsdk`, with its own dependencies and tests, consumed from its TypeScript source with no build. Beside its entry it exports `zipkitsdk/types` (the types alone, for code that loads no Node modules) and `zipkitsdk/testing` (the bounded file access and Node's file system as it plugs in, for fault-injection tests).
