# ZipKit

ZipKit is a cross-platform **ZIP archiver and portability linter/fixer** for macOS and Windows, with a TypeScript SDK underneath. It produces archives that carry nothing a recipient on another OS will trip over, and it reads them back — `extract` verifies an archive's CRC integrity (and, against an embedded manifest, its completeness and per-file content identity), then unpacks it.

The compression is the small part; the value is the **portability checks and the policy** that decides each one — NFD-decomposed names, Windows-illegal characters, reserved device names, OS junk files, and Unix-only attributes — each fixed, warned, or made a hard build-failing error per your settings. The planning core is pure (a dry run is faithful to the real write by construction), and the desktop app drives that same SDK. Out of scope: repairing existing archives, encryption, compression methods beyond Store and Deflate, and split/multi-volume archives. The project is at 0.x.

## Download

Prebuilt installers and portable builds of the desktop app for macOS (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/zipkit/releases/latest) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/ZipKit.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Run the desktop app from source

Install Node.js **22.12+**, run `npm install`, then choose one path:

- Development: `npm run dev`, or the `scripts/run-dev.*` launcher.
- Packaged behavior: run `scripts/rebuild.*` once, then use `scripts/run-built.*` for instant later launches. Rebuild again after source changes.

The app uses no keys, services, or network; archive work stays local.

## Use the SDK

Drive the SDK with a `plan → inspect → write` flow:

```ts
import { ZipKit } from "zipkit";

const zip = new ZipKit();
const plan = await zip.plan({ inputs: ["./my-project"], output: "out.zip" });
if (plan.writable) await zip.write(plan); // or: zip.create({ inputs, output })
```

The SDK is ESM and consumed directly from TypeScript source. Run the script with [`tsx`](https://tsx.is), for example `npx tsx your-script.ts`; there is no SDK build to keep in sync.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>
