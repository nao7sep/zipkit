// The stores label-fit seeds, each with the file header the app's loader
// checks: the language under test, every pane at width 0 (so the layout reader
// clamps each to its minimum and the labels are checked at their tightest), and
// one job. Its own module so the app's tests can check the app accepts them.
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** A store document as the app writes it: the header, then the store's own keys. */
function headed(kind, body) {
  return { format: { owner: "zipkit", kind, version: 1 }, writer: { name: "zipkit", version }, ...body };
}

export const LABEL_FIT_LAYOUT = headed("layout", { layout: { jobsWidth: 0, statusWidth: 0, recordsListWidth: 0 } });

export function labelFitConfig(language) {
  return headed("config", { language, theme: "light" });
}

export function labelFitQueue(input) {
  return headed("queue", { jobs: [{ id: "fit", inputs: [input], options: {} }] });
}
