# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The embedded manifest is now `zipkit.json` (was `_metadata.json`). Its header opens with `about`, `app`, `version`, `repository`, `createdAtUtc` and `formatVersion`, replacing `tool` and `createdUtc`. Verify looks for `zipkit.json` only; to verify an archive written by 0.1.0, SDK callers pass `metadataName: "_metadata.json"`.

## [0.1.0] - 2026-07-08

### Added

- First public release.
