# ZipKit

ZipKit is a cross-platform **ZIP archiver and portability linter/fixer** — a TypeScript SDK with a desktop app built on it. It produces archives that are clean across platforms: one made on macOS carries nothing a Windows user will trip over, and the reverse. And it reads them back — `extract` verifies an archive's CRC integrity (and, against an embedded manifest, its completeness and per-file content identity), then unpacks it.

The compression is the small part; the value is the **portability checks and the policy** that decides each one — NFD-decomposed names, Windows-illegal characters, reserved device names, OS junk files, Unix-only attributes, unknown extra fields — each fixed, warned, or made a hard build-failing error per your settings. It's SDK-first: the planning core is pure (a dry run is faithful to the real write by construction), and the desktop app is a thin wrapper over it.

## Requirements

- Node.js **22.12+** (ESM). The SDK is consumed directly from its TypeScript source — there is no build step; run your scripts with [`tsx`](https://tsx.is) (`npx tsx your-script.ts`).
- The desktop app is **Electron** (macOS/Windows) and is still in active development.
- No keys, services, or network — everything runs locally.

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

## Scope

Creates clean, portable archives from a source tree and reads them back — extraction, plus validation (CRC always, and against the embedded manifest, completeness and SHA-256). **Out of scope:** repairing or re-writing existing archives, encryption, compression methods beyond Store and Deflate, and split or multi-volume archives.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
