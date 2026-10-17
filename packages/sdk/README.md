# zipkit

Make ZIP archives that open cleanly on any system, and read them back. ZipKit fixes file names other systems cannot hold (decomposed Unicode, characters Windows forbids, reserved device names), leaves out OS junk such as `.DS_Store` and `Thumbs.db`, embeds a manifest of every file, and verifies the result. Each rule is fixed, warned about or made a blocking error by your policy. This package is the SDK and the `zipkit` command; the [ZipKit desktop app](../../README.md) is built on it.

ESM for Node.js 22.12 or later, with type declarations. It reads no environment variables, prints nothing, and writes nothing outside the paths you give it.

```ts
import { ZipKit } from "zipkit";

const zip = new ZipKit();
const plan = await zip.plan({ inputs: ["./my-project"] }); // decides everything, writes nothing
for (const f of plan.findings) console.log(f.severity, f.rule, f.path, f.message);
if (plan.writable) {
  const written = await zip.write(plan, { onProgress: (c) => console.log(c.bytesDone, "/", c.bytesTotal) });
  const check = await zip.extract({ archive: written.output, dryRun: true, checkMetadata: true });
  console.log(check.reportOk);
}
```

```sh
zipkit plan ./my-project
zipkit create ./my-project -o my-project.zip
zipkit verify my-project.zip
```

- [Guide and reference](docs/sdk.md)
- [Rules, exclusion codes and error codes](docs/rules.md)
- [The `zipkit` command](docs/cli.md)
- [Changelog](CHANGELOG.md)

## Develop

From the repository root, `npm install` links the package into the workspace. In `packages/sdk`, `npm test` type-checks and runs its tests, and `npm run build` builds it into `dist/`.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi
