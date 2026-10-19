# zipkitsdk

Make ZIP archives that open cleanly on any system, and verify them. The SDK fixes file names other systems cannot hold (decomposed Unicode, characters Windows forbids, reserved device names), leaves out what your exclusion patterns match (by default, system leftovers such as `.DS_Store` and `Thumbs.db`), embeds a manifest of every file, verifies the result, and checks whether the originals can be removed without losing data. Each name rule is fixed, warned about or made a blocking error by your policy. The [ZipKit desktop app](../README.md) is built on it.

ESM for Node.js 22.18.0 or later, consumed from its TypeScript source. It reads nothing from its environment, prints nothing, keeps no data of its own, and writes nothing outside the paths you give it, which are absolute.

```ts
import { ZipKit } from "zipkitsdk";

const zip = new ZipKit();
const plan = await zip.plan({ inputs: ["/Users/me/my-project"] }); // decides everything, writes nothing
for (const f of plan.findings) console.log(f.severity, f.rule, f.path, f.message);
if (plan.writable) {
  const written = await zip.write(plan, { onProgress: (c) => console.log(c.bytesDone, "/", c.bytesTotal) });
  const check = await zip.verify(written.output, { manifest: true });
  console.log(check.ok, check.findings);
}
```

The public types in `src/types.ts`, the exported tables (`RULE_REGISTRY`, `ERROR_CODES`, `DEFAULT_EXCLUSIONS`) and the tests are the reference. Changes are in the [changelog](CHANGELOG.md).

## Develop

From the repository root, `npm install` links the package into the workspace. In `sdk/`, `npm test` type-checks and runs its tests.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi
