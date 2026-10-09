# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The embedded manifest is now `zipkit.json` (was `_metadata.json`). Its header opens with `about`, `app`, `version`, `repository`, `createdAtUtc` and `formatVersion`, replacing `tool` and `createdUtc`. Verify looks for `zipkit.json` only. A 0.1.0 manifest (`_metadata.json`) carries no `formatVersion`, so checking an archive against it fails with `read.manifest-invalid`; the CRC-32 check without `checkMetadata` still verifies such an archive.
- The environment variable that moves ZipKit's data folder is now `ZIPKIT_DATA_DIR` (was `ZIPKIT_HOME`). `ZIPKIT_HOME` is no longer read: a ZipKit started with only it set uses `~/.zipkit`, and the folder it named is left as it is.
- `queue.json` and `layout.json` no longer carry a `version` key; one left by 0.1.0 is ignored and dropped at the next save. A file ZipKit cannot read is never overwritten. Running an older ZipKit on files a newer one wrote is not supported.
- A damaged `layout.json` puts the panes back at their default widths without a message, and a failed pane layout save is only logged.
- Verify refuses an embedded manifest whose `formatVersion` is newer than the running build reads, with the error code `read.manifest-newer`, and one without `formatVersion` with `read.manifest-invalid`.
- ZipKit no longer rewrites its queue or layout file when nothing in it changed, and extraction with overwrite leaves a file or symlink that already holds the entry's content as it is, reporting the entry as skipped with `unchanged`.
- Every folder an archive keeps is written as its own entry, not only empty ones, so its modification time is stored and extraction restores it.
- Archives store each file's Unix permissions, and extraction applies them to every file it creates; a file it replaces keeps its own. Creation times, extended attributes and Finder tags are still not restored.
- Verify and the source check before deleting originals refuse an embedded manifest with a malformed or repeated entry record with `read.manifest-invalid`, instead of skipping the checks that record could not support.

### Fixed

- The "before 1980" and "after 2107" warnings are judged in the time zone the archive's DOS times are written in, so they appear exactly when a time is clamped.
- Extraction restores folder modification times, once each folder's files are written.
- Extraction restores file and folder times below the millisecond from the NTFS time field, which stores them to 100 ns; it no longer drops the digits after the millisecond.
- Extraction ignores another tool's NTFS time field when it is malformed or unset, and uses the next stored time instead.
- Extracting a symlink with overwrite onto an existing file keeps that file when the link cannot be created, as on Windows without symlink rights.
- Saving an archive or extracting a file without overwrite on a FAT volume that refuses hard links no longer fails as if the file already existed.
- Archiving a folder that holds ZipKit's own data folder (`~/.zipkit` or `ZIPKIT_DATA_DIR`), such as the home folder, leaves that data folder out, as does an input or followed link inside it.
- Extraction writes each file's temporary copy in the file's own folder, so extracting into a folder that holds a mounted volume no longer fails there.
- The message after an unreadable settings or queue file was set aside names the `.invalid` file it was kept as.
- A saved queue with some jobs that cannot be read restores the jobs it can read; the whole file, with every job in it, is set aside and reported.
- One invalid saved default job option resets only itself; the comment, output folder and file name saved beside it are kept.
- Changing a job's options and then selecting another job no longer loses the change: boxes, choices and folders are sent as soon as they change, and typing still waiting is sent when another job is selected. Quitting within about a quarter-second of typing can still lose those last characters.
- Settings no longer reports a save as failed while it may still complete. The dialog stays as it is, its fields and Cancel disabled, until the save finishes, then closes, or stays open with the error.
- A queue that cannot be saved is reported: the main window shows a notice until a later save succeeds, and when it fails as you quit, ZipKit stays open and offers Retry, Quit Anyway or Cancel. A logout, restart or shutdown never asks; it logs the failure.
- A Windows logoff, restart or shutdown saves the queue before ZipKit ends, and on macOS a job still running at logout is cancelled without asking. Every quit step has a bound, so quitting ends within about 4 seconds instead of waiting up to 10 seconds a step, and a pane layout write still in progress at quit lands first.
- On Windows, closing the main window while a job runs or after a failed queue save keeps it open when you choose to keep working or cancel.
- A failed save of the settings, queue or layout no longer leaves a temporary file in ZipKit's data folder.
- Overwriting an archive or an extracted file, and saving ZipKit's own settings, queue and layout, keep the replaced file's permissions.

## [0.1.0] - 2026-07-08

### Added

- First public release.
