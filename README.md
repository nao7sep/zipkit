# ZipKit

Make ZIP archives on a Mac that open cleanly on Windows: fix file names, leave out system leftovers, and verify the result. ZipKit is a cross-platform **ZIP archiver and portability linter/fixer**, with a TypeScript SDK underneath. It produces archives that carry nothing a recipient on another OS will trip over, and verifies each one: every entry's CRC-32 and header, and, against the embedded manifest, its completeness and every file's SHA-256. Before it moves or deletes the originals, it checks them again, by content, against what the archive holds.

Embedded manifests have no size limit. ZipKit writes a manifest and reads it back one record at a time, so even a folder of hundreds of thousands of files is archived and verified without holding the whole manifest in memory.

The compression is the small part; the value is the **portability checks and the policy** that decides each one — NFD-decomposed names, Windows-illegal characters, reserved device names, system leftovers matched by editable exclusion patterns, and Unix-only attributes — each fixed, warned, or made a hard build-failing error per your settings. The planning core is pure (a dry run is faithful to the real write by construction), and the desktop app drives that same SDK. Out of scope: repairing existing archives, encryption, compression methods beyond Store and Deflate, and split/multi-volume archives.

## Download

Prebuilt installers and portable builds of the desktop app for macOS 13 or later (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/zipkit/releases/latest) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/ZipKit.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Run the desktop app from source

Install Node.js **22.18+**, run `npm install`, then choose one path:

- Development: `npm run dev`, or the `scripts/run-dev.*` launcher.
- Packaged behavior: run `scripts/rebuild.*` once, then use `scripts/run-built.*` for instant later launches. Rebuild again after source changes.

The app uses no keys, services, or network; archive work stays local.

Ordinary quit captures the latest job edits before saving the queue. Settings and completed ZIP archives request a file flush before publication and a directory flush where the runtime and filesystem support it. Windows supports the file flush through Node but not the directory flush. These requests improve durability without guaranteeing survival of every hardware failure or power loss. Queue and layout saves remain atomic, without the extra flushes. If an archive's publication flush fails, ZipKit reports the failure and keeps the originals.

## Use the SDK

The SDK is the library the app is built on, for any other app. It is a package of its own, [`sdk/`](sdk) (named `zipkitsdk`), with its own dependencies and tests, consumed from its TypeScript source; the app bundles it.

```ts
import { ZipKit } from "zipkitsdk";

const zip = new ZipKit();
const plan = await zip.plan({ inputs: ["/Users/me/my-project"] });
for (const f of plan.findings) console.log(f.severity, f.rule, f.path);
if (plan.writable) await zip.write(plan); // or zip.create(spec) in one call
```

`npm test` type-checks and runs both the app's tests and the SDK's; `npx vitest` at the root runs either by path.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>
