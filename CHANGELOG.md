# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The embedded manifest is now `zipkit.json` (was `_metadata.json`). Its header opens with `about`, `app`, `version`, `repository`, `createdAtUtc` and `formatVersion`, replacing `tool` and `createdUtc`. Verify looks for `zipkit.json` only; to verify an archive written by 0.1.0, SDK callers pass `metadataName: "_metadata.json"`.
- ZipKit's own files (`config.json`, `queue.json`, `layout.json` and the records and backups databases) record their format version; `queue.json` and `layout.json` carry `formatVersion` in place of `version`. A launch that finds one of the JSON files written by a newer ZipKit stops, names the file and leaves it unchanged.
- Verify refuses an embedded manifest whose `formatVersion` is newer than the running build reads, with the error code `read.manifest-newer`; a manifest without `formatVersion` reads as format 1.

### Fixed

- The "before 1980" and "after 2107" warnings are judged in the time zone the archive's DOS times are written in, so they appear exactly when a time is clamped.
- Extraction restores folder modification times, once each folder's files are written.
- Extraction ignores another tool's NTFS time field when it is malformed or unset, and uses the next stored time instead.

## [0.1.0] - 2026-07-08

### Added

- First public release.
