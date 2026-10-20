# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The SDK is a package of its own, `zipkitsdk` in [sdk/](sdk), which the app bundles from its source; its changes are in [its changelog](sdk/CHANGELOG.md).
- Settings has three tabs: General, New job parameters and Exclusion patterns. The exclusion patterns are one list, edited whole: each is a glob or a regular expression, applies to files, folders or both, can match in any case, and carries a note. The list ZipKit starts with holds 34 patterns, among them what old drives keep (Windows' memory files, older Recycle Bins, the classic Mac OS desktop database), each described in the interface language. A new job takes the list Settings has when the job is added.
- The manifest's file name is a job parameter (`zipkit.json` by default).
- Before the originals are moved to the Trash or deleted, every one of them is read again and compared with what the archive recorded (its SHA-256, or its CRC-32 when no hash was recorded), so a file changed without changing its size or modification time keeps the originals in place. A refusal lists what changed where it is on disk.
- Writing, verifying and the recheck before removal fill the status bar by bytes; the archive card says how much of the originals' size the archive takes; Details lists items where they are on disk.

### Changed

- The embedded manifest is now `zipkit.json` (was `_metadata.json`). Its header opens with `about`, `writer` (`zipkitsdk` with its version), `app` (ZipKit with its version), `createdAtUtc`, `format` (`zipkit.manifest`) and `formatVersion`, replacing `tool` and `createdUtc`. It records each left-out item's code and the exclusion pattern by its id, never the pattern's description. Verify looks for the job's manifest name only. A 0.1.0 manifest (`_metadata.json`) carries no `formatVersion`, so checking an archive against it fails with `manifest.invalid`; the check without the manifest still verifies such an archive.
- "Drop OS junk files" is now "Leave out what the exclusion patterns match", and what it leaves out is the editable list in Settings.
- A name ZipKit gives an archive from the folder it archives is fixed like the names inside it, so a folder named `Q1: Plans?` gives `Q1 Plans.zip`; a name you type is kept and warned about when Windows cannot hold it.
- The warning for paths too long for Windows counts the folder Windows' Extract All makes, named after the archive, and room for where it is put.
- Verify checks each entry's local header against the archive's directory, as tools that read local headers see it, and reports an entry whose data cannot be read (an unsupported method, a wrong size, a broken stream) instead of stopping.
- The environment variable that moves ZipKit's data folder is now `ZIPKIT_DATA_DIR` (was `ZIPKIT_HOME`). `ZIPKIT_HOME` is no longer read: a ZipKit started with only it set uses `~/.zipkit`, and the folder it named is left as it is.
- A folder holding ZipKit's data folder, such as the home folder, is archived like any other; when one of ZipKit's own files there changes while the archive is written, the archive fails as changed.
- `queue.json` and `layout.json` no longer carry a `version` key; one left by 0.1.0 is ignored and dropped at the next save. A file ZipKit cannot read is never overwritten. Running an older ZipKit on files a newer one wrote is not supported.
- The backup history in `backups.sqlite3` keeps one copy of the settings file per launch, the last one saved in that launch, instead of one per save, and no longer keeps copies of the job list. Copies already kept stay as earlier history.
- ZipKit's own fallback log file is named to the second.
- The questions ZipKit asks when quitting use its own dialog, on the main window when one is open, with sentence-case buttons like the rest of the app, and the busy-job question no longer says the archive is going to the Trash when it is the originals.
- The Records window's combined level filter is called "Warnings and errors" (was "Needs attention"); it shows the same records.
- Arrow keys move a pane divider 16 pixels at a time (was 10), and a keyboard resize is saved once, when the key is released.
- A damaged `layout.json` puts the panes back at their default widths without a message, and a failed pane layout save is only logged.
- Verify refuses an embedded manifest whose `formatVersion` is newer than the running build reads, with the error code `manifest.newer`, one without `formatVersion` with `manifest.invalid`, and one that names another format.
- ZipKit no longer rewrites its queue or layout file when nothing in it changed.
- Every folder an archive keeps is written as its own entry, not only empty ones, so its modification time is stored.
- Archives store each file's Unix permissions.
- Verify and the recheck before removing originals refuse an embedded manifest with a malformed or repeated entry record with `manifest.invalid`, instead of skipping the checks that record could not support.

### Removed

- The Help dialog. What ZipKit fixes and checks is to be explained on a page.

### Fixed

- The "before 1980" and "after 2107" warnings are judged in the time zone the archive's DOS times are written in, so they appear exactly when a time is clamped.
- Saving an archive without overwrite on a FAT or exFAT volume that refuses hard links no longer fails as if the file already existed, and never leaves a partial archive there: the finished archive is renamed into place once its name is confirmed free.
- A file that appears at the archive's path while the job runs stops the job for attention instead of failing it, and is kept.
- Deleting originals for good reports one that was already gone as gone, not as a failure.
- An archive whose name is taken, or a source file that disappears while it is archived, is reported by what happened and where, instead of as a failure to write the archive.
- A link to a folder whose name starts with two dots, such as `..notes`, is followed like any other folder inside the input.
- A pattern of yours ending in `/` leaves out folders only, as the built-in ones do.
- Names longer than 255 bytes of UTF-8, which Linux file systems refuse, are flagged as too long; names that differ only by Greek final and medial sigma are caught as a case collision; `CON .txt` and the like are treated as reserved; entries are planned and written in the same order on every run.
- The message after an unreadable settings or queue file was set aside names the `.invalid` file it was kept as.
- A saved queue with some jobs that cannot be read restores the jobs it can read; the whole file, with every job in it, is set aside and reported.
- One invalid saved default job option resets only itself; the comment, output folder and file name saved beside it are kept.
- Changing a job's options and then selecting another job no longer loses the change: boxes, choices and folders are sent as soon as they change, and typing still waiting is sent when another job is selected. Quitting within about a quarter-second of typing can still lose those last characters.
- Writing an archive to a slow destination, such as a USB drive or network share, no longer holds the compressed data waiting for it in memory; ZipKit compresses only as fast as the destination takes the bytes.
- A destination that stops responding while the finished archive is being saved into place is reported as the archive possibly still appearing at its path, not as an archive that could not be written.
- Move archive to Trash works like Move originals to Trash: the job offers only Cancel until it ends, a second click, Retry, Move originals and removing the job wait for it, and Cancel or quitting stops the wait and says the archive may still reach the Trash. Quitting while either is in progress asks first, and says that files already sent to the Trash may still arrive there.
- While a job moves files to the Trash, its row no longer shows a remove button that did nothing.
- On macOS, after another app cancels a logout, quitting ZipKit asks its questions again once a minute has passed, instead of quitting silently for the rest of the session.
- A quit whose steps could not finish in time, such as with a network drive that stopped responding, now ends ZipKit instead of leaving it hanging without a window.
- Settings no longer reports a save as failed while it may still complete. The dialog stays as it is, its fields and Cancel disabled, until the save finishes, then closes, or stays open with the error.
- A queue that cannot be saved is reported: the main window shows a notice until a later save succeeds, and when it fails as you quit, ZipKit stays open and offers Retry, Quit Anyway or Cancel. A logout, restart or shutdown never asks; it logs the failure.
- A Windows logoff, restart or shutdown saves the queue before ZipKit ends, and on macOS a job still running at logout is cancelled without asking. Every quit step has a bound, so quitting ends within about 4 seconds instead of waiting up to 10 seconds a step, and a pane layout write still in progress at quit lands first.
- On Windows, closing the main window while a job runs or after a failed queue save keeps it open when you choose to keep working or cancel.
- A failed save of the settings, queue or layout no longer leaves a temporary file in ZipKit's data folder.
- Overwriting an archive, and saving ZipKit's own settings, queue and layout, keep the replaced file's permissions.

## [0.1.0] - 2026-07-08

### Added

- First public release.
