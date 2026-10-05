# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The embedded manifest is now `zipkit.json` (was `_metadata.json`). Its header opens with `about`, `app`, `version`, `repository`, `createdAtUtc` and `formatVersion`, replacing `tool` and `createdUtc`. Verify looks for `zipkit.json` only; to verify an archive written by 0.1.0, SDK callers pass `metadataName: "_metadata.json"`.

### Fixed

- The "before 1980" and "after 2107" warnings are judged in the time zone the archive's DOS times are written in, so they appear exactly when a time is clamped.
- Extraction restores folder modification times, once each folder's files are written.
- Extraction ignores another tool's NTFS time field when it is malformed or unset, and uses the next stored time instead.

## [0.1.0] - 2026-07-08

### Added

- First public release.
