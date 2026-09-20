# ZipKit's areas, and the tests that stand for them

`npm test` is the type check plus this whole suite: at a few seconds it is already a fixed, balanced
run, so nothing selects a subset of it. This file is the balance judgement the
`tests-folder-conventions` require — which areas ZipKit has, and which tests stand for each — so a
reader can tell what a green run covered, and an area with no test standing for it is visible rather
than merely absent. `tests/area-map.test.ts` holds every path below to what is on disk.

Paths are relative to this folder.

| Area | What it covers | Tests standing for it |
|---|---|---|
| Planning core | The pure dry run: what would be written, named, skipped, and fixed | `sdk/plan/plan.test.ts`, `sdk/plan/arcname.test.ts`, `sdk/plan/dedup.test.ts`, `sdk/plan/collision.test.ts`, `sdk/plan/zip64.test.ts` |
| Portability policy | Which findings are fixed, warned, or fatal, and the rules behind each | `sdk/policy.test.ts`, `sdk/plan/nameFix.test.ts`, `sdk/plan/pathFix.test.ts`, `sdk/plan/symlinks.test.ts`, `sdk/plan/timestamps.test.ts`, `sdk/validate.test.ts`, `sdk/registry.test.ts` |
| Scanning | Walking the inputs and reporting what was found | `sdk/scan/scan.test.ts`, `sdk/scan/output.test.ts`, `sdk/plan/emptyDirs.test.ts`, `sdk/plan/emptyFiles.test.ts` |
| Filtering | Include and exclude matching against the scanned entries | `sdk/filter/match.test.ts`, `sdk/plan/filterPass.test.ts` |
| Archive writing | Producing the archive and its manifest, and publishing it only on success | `sdk/create.test.ts`, `sdk/write/zipWriter.test.ts`, `sdk/write/publish.test.ts`, `sdk/write/metadata.test.ts` |
| Extraction and verification | Reading an archive back, checking CRC and manifest, and unpacking it | `sdk/extract/extract.test.ts`, `sdk/extract/zipReader.test.ts`, `sdk/extract/restore.test.ts`, `sdk/extract/targetCollision.test.ts` |
| Cancellation | Aborting a run and draining what it started | `sdk/abort.test.ts`, `sdk/internal/drain.test.ts` |
| Logging and redaction | The session log, its messages, and the secrets kept out of it | `sdk/log/logger.test.ts`, `sdk/log/messages.test.ts`, `sdk/log/redact.test.ts`, `sdk/log/session.test.ts`, `sdk/session-log.test.ts` |
| Storage paths | Where the app resolves its settings, logs, and output | `sdk/storage.test.ts`, `sdk/version.test.ts` |
| Desktop queue and IPC | The main process's job queue and the calls the renderer makes | `gui/main/ipc.test.ts`, `gui/main/queue.test.ts`, `gui/main/queue-engine.test.ts`, `gui/main/runtime.test.ts`, `gui/main/output.test.ts`, `gui/main/inputs.test.ts` |
| Settings and persisted state | Saved settings, managed JSON, and their backups | `gui/main/settings.test.ts`, `gui/main/persist.test.ts`, `gui/main/managedJson.test.ts`, `gui/main/backupStore.test.ts`, `gui/main/log.test.ts` |
| Startup, quit, and recovery | Opening, closing, and coming back from an interrupted session | `gui/main/startup-entry.test.ts`, `gui/main/startup-dialog.test.ts`, `gui/main/quit.test.ts`, `gui/main/recoveryDialogs.test.ts`, `gui/main/window-state-recovery.test.ts` |
| Window, theme, and styling | Window bounds and minimums, light and dark, and the stylesheet | `gui/main/window-options.test.ts`, `gui/main/window-minimum.test.ts`, `gui/main/theme.test.ts`, `gui/renderer/theme-contrast.test.ts`, `gui/renderer/styles.test.ts`, `gui/main/layout.test.ts`, `gui/shared/layout.test.ts` |
| Renderer interaction | What the window does under the pointer and the keyboard | `gui/renderer/view.test.ts`, `gui/renderer/shortcuts.test.ts`, `gui/renderer/listbox-nav.test.ts`, `gui/renderer/input-admission.test.ts`, `gui/renderer/components/input-list-drag.test.ts`, `gui/renderer/external-drop-boundary.test.ts`, `gui/renderer/composition.test.ts`, `gui/renderer/textCleanup.test.ts` |
| Window activity | Which window is active, and what the main process and preload agree about it | `gui/main/windowActivity.test.ts`, `gui/main/preload-windowActivity.test.ts`, `gui/renderer/windowActivity.test.ts`, `gui/main/navigation.test.ts` |
| Security boundary | The content policy, the URLs the app will open, and the paths it refuses | `gui/main/csp.test.ts`, `gui/main/safety.test.ts`, `gui/main/url.test.ts` |
| Packaging and launchers | What ships, how it is built, and the double-clickable launchers | `config/electron-vite.test.ts`, `config/launcher-runtime.test.ts`, `main/installer-config.test.ts`, `gui/shared/spec.test.ts` |

ZipKit has nothing paid, external, or heavy in the product, so there is no `test:full`: `npm test` is
the full gate.
