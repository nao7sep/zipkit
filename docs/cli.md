# The `zipkit` command

`zipkit` makes, checks and lists archives from a shell, with the same rules as the desktop app. It is built on the [SDK](sdk.md) alone.

```sh
zipkit plan ~/Projects/site                 # what the archive would hold; writes nothing
zipkit create ~/Projects/site -o site.zip   # make it, unless something blocks
zipkit verify site.zip                      # every CRC-32, and the embedded manifest
zipkit list site.zip                        # the entries, without verifying them
```

`plan` and `create` print the archive's path, how many items are included, excluded and renamed, every error and warning, and the notes (fixed names, junk left out) as counts per rule. `create` writes nothing when the plan blocks, and prints the findings that block it. On a terminal, `create` and `verify` show how many items and bytes are done.

## Options

| Option | Commands | |
| --- | --- | --- |
| `-o, --output <file>` | plan, create | The archive's path; by default it goes beside the inputs |
| `--output-dir <dir>` | plan, create | The folder the archive goes in |
| `--name <name>` | plan, create | The archive's file name |
| `--overwrite` | plan, create | Replace an existing archive |
| `--exclude <glob>` | plan, create | Leave out what matches; repeatable |
| `--no-junk` | plan, create | Keep OS junk such as `.DS_Store` |
| `--names <action>` | plan, create | `fix`, `warn`, `error` or `none`, for every name rule |
| `--symlinks <mode>` | plan, create | `ignore`, `preserve` or `follow` |
| `--no-manifest` | plan, create | Embed no `zipkit.json` |
| `--no-hash` | plan, create | Record no SHA-256 in the manifest |
| `--comment <text>` | plan, create | The archive comment |
| `--crc-only` | verify | Check CRC-32 only, for an archive without a manifest |
| `--json` | all | Print the SDK's result as JSON |
| `-q, --quiet` | all | Print no progress or summary |

`--json` prints the plan, the write result, the verification or the listing exactly as the SDK returns them; [rules.md](rules.md) lists every `rule`, `excludeCode` and error `code` in them.

## Exit codes

| Code | |
| --- | --- |
| 0 | Done |
| 1 | Refused: the plan blocks, or the archive did not verify |
| 2 | Usage: an unknown command or option, or a missing argument |
| 3 | Policy: the spec or options are invalid (`PolicyError`) |
| 4 | Scan: an input cannot be read (`ScanError`) |
| 5 | Write: the archive could not be written (`WriteError`) |
| 6 | Read: the archive cannot be read (`ReadError`) |
| 7 | A drive or share stopped responding (`StallError`) |
| 130 | Cancelled with Ctrl-C; a cancelled `create` leaves no archive |

An error prints its message and its code, such as `(read.manifest-missing)`, to standard error.
