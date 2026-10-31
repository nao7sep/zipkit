#!/usr/bin/env node
// Renders the built app (`npm run build:gui` first) in every interface language
// at its minimum window and pane sizes, with every window hidden, and reports
// text that is clipped, truncated, wraps inside a button, or escapes its
// container. jsdom cannot measure text, so this is the fit check for labels
// that grow in translation (a German no-break space before "…", for example).
// Each language runs from its own disposable folder under the OS temp folder,
// which is removed afterwards; no other data folder is opened.
//
//   node scripts/label-fit.mjs [language ...]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(repo, "out/main/index.js"))) {
  console.error("Build the app first: npm run build:gui");
  process.exit(2);
}
const all = readdirSync(join(repo, "src/gui/shared/i18n/locales")).map((name) => name.replace(/\.json$/, ""));
const languages = process.argv.length > 2 ? process.argv.slice(2) : all;

let failed = false;
for (const language of languages) {
  const work = mkdtempSync(join(tmpdir(), `zipkit-label-fit-${language}-`));
  try {
    const data = join(work, "data");
    const input = join(work, "input", "Quarterly report drafts");
    mkdirSync(data, { recursive: true });
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "notes.txt"), "label fit\n");
    writeFileSync(join(data, "config.json"), JSON.stringify({ language, theme: "light" }));
    writeFileSync(join(data, "layout.json"), JSON.stringify({ jobsWidth: 0, statusWidth: 0, recordsListWidth: 0 }));
    writeFileSync(join(data, "queue.json"), JSON.stringify({ jobs: [{ id: "fit", inputs: [input], options: {} }] }));
    const result = join(work, "result.json");
    const run = spawnSync(electronPath, [join(repo, "scripts/label-fit-main.mjs")], {
      env: { ...process.env, ZIPKIT_DATA_DIR: data, LABEL_FIT_RESULT: result, LABEL_FIT_USER_DATA: join(work, "user-data") },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (!existsSync(result)) {
      failed = true;
      console.log(`${language}: no result (exit ${run.status ?? run.signal})\n${run.stderr}`);
      continue;
    }
    const { findings, error } = JSON.parse(readFileSync(result, "utf8"));
    if (error) failed = true;
    failed ||= findings.length > 0;
    console.log(`${language}: ${error ? `error: ${error}` : findings.length === 0 ? "fits" : ""}`);
    for (const finding of findings) console.log(`  ${finding.surface}: ${finding.issue}: ${JSON.stringify(finding.text)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
