/**
 * The archive's own file name, held to the rules its entries are held to. An
 * archive travels like any file, so a name Windows or a FAT drive cannot hold
 * (`Q1: Plans?.zip`, `CON.zip`) is as much a problem as one inside it. A name
 * ZipKit inferred from what it archives is fixed under the `names` policy, the
 * way an entry's would be; a name the caller gave is never changed, only
 * reported, so a `fix` action reports it as a warning there. The `.zip`
 * extension is kept apart, so only the stem is judged.
 */

import path from "node:path";
import type { NameAction, NameRules } from "../types.ts";
import { processSegment, type SegmentIssue } from "./nameFix.ts";

export interface OutputNameCheck {
  /** The archive's path, with an inferred name fixed. */
  path: string;
  issues: SegmentIssue[];
}

/** The rules for a name the caller chose: every fix only reported. */
function reportOnly(names: NameRules): NameRules {
  const report = (action: NameAction): NameAction => (action === "fix" ? "warn" : action);
  return {
    ...names,
    nfc: report(names.nfc),
    invalidChars: report(names.invalidChars),
    controlChars: report(names.controlChars),
    trailingDotSpace: report(names.trailingDotSpace),
    reserved: report(names.reserved),
  };
}

export function checkOutputName(output: string, inferred: boolean, names: NameRules): OutputNameCheck {
  const base = path.basename(output);
  const extension = /\.zip$/i.exec(base)?.[0] ?? "";
  const stem = base.slice(0, base.length - extension.length);
  const fix = processSegment(stem, inferred ? names : reportOnly(names));
  if (fix.segment === stem) return { path: output, issues: fix.issues };
  return { path: path.join(path.dirname(output), fix.segment + extension), issues: fix.issues };
}
