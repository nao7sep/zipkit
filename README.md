# ZipKit

ZipKit is a cross-platform **ZIP archiver and portability linter/fixer** — a TypeScript SDK with a desktop app built on it, for developers who hand off ZIP archives across macOS and Windows and need them to arrive clean. It produces archives that carry nothing a recipient on another OS will trip over, and it reads them back — `extract` verifies an archive's CRC integrity (and, against an embedded manifest, its completeness and per-file content identity), then unpacks it.

The compression is the small part; the value is the **portability checks and the policy** that decides each one — NFD-decomposed names, Windows-illegal characters, reserved device names, OS junk files, Unix-only attributes, unknown extra fields — each fixed, warned, or made a hard build-failing error per your settings. It's SDK-first: the planning core is pure (a dry run is faithful to the real write by construction), and the desktop app is a thin wrapper over it. Out of scope: repairing existing archives, encryption, compression methods beyond Store and Deflate, and split/multi-volume archives. The project is pre-release (0.x).

## Requirements

- Node.js **22.12+** (ESM). The SDK is consumed directly from its TypeScript source — there is no build step; run your scripts with [`tsx`](https://tsx.is) (`npx tsx your-script.ts`).
- The desktop app is **Electron** (macOS/Windows) and is still in active development.
- No keys, services, or network — everything runs locally.

## Download

Prebuilt installers and portable builds of the desktop app for macOS (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/zipkit/releases) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/ZipKit.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Getting started

Drive the SDK with a `plan → inspect → write` flow:

```ts
import { ZipKit } from "zipkit";

const zip = new ZipKit();
const plan = await zip.plan({ inputs: ["./my-project"], output: "out.zip" });
if (plan.writable) await zip.write(plan); // or: zip.create({ inputs, output })
```

Run it with `npx tsx your-script.ts`; `import "zipkit"` resolves to the TypeScript source, so there's no build to keep in sync.

The desktop app (in development) runs with `npm install` then `npm run dev`, or the `scripts/run-dev.*` launchers.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
