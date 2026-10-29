/**
 * Builds the Records window demo (`records-demo.ts`): the app's own build with
 * the demo as one more main-process entry, written to `out/records-demo/` so
 * the app's `out/` parts, which the package is made from, stay as they were.
 * `npm run demo:records` builds and opens it; the live test builds it too.
 */

import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "electron-vite";
import app from "../../electron.vite.config";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const out = resolve(repo, "out/records-demo");
// electron-vite bundles this file with the app's config, whose
// `import.meta.dirname` then names this folder; its paths are moved back.
const fromRepo = (file: string): string => resolve(repo, relative(here, file));
const inputs = (input: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(input as Record<string, string>).map(([name, file]) => [name, fromRepo(file)]));

const base = app as UserConfig;
const { main, preload, renderer } = base;

export default {
  ...base,
  main: {
    ...main,
    build: {
      ...main?.build,
      outDir: resolve(out, "main"),
      rolldownOptions: {
        ...main?.build?.rolldownOptions,
        input: { ...inputs(main?.build?.rolldownOptions?.input), "records-demo": resolve(here, "records-demo.ts") },
      },
    },
  },
  preload: {
    ...preload,
    build: {
      ...preload?.build,
      outDir: resolve(out, "preload"),
      rolldownOptions: { ...preload?.build?.rolldownOptions, input: inputs(preload?.build?.rolldownOptions?.input) },
    },
  },
  renderer: {
    ...renderer,
    root: fromRepo(renderer!.root!),
    build: {
      ...renderer?.build,
      outDir: resolve(out, "renderer"),
      rolldownOptions: { ...renderer?.build?.rolldownOptions, input: inputs(renderer?.build?.rolldownOptions?.input) },
    },
  },
} satisfies UserConfig;
