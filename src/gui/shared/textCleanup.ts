/**
 * The app's text-cleanup helper (text-cleanup-conventions): `singleLine` for the
 * UI font, `multiline` for the archive comment. Pure and Node-free, so the
 * renderer cleans on blur and the main process compares with the same code.
 * Copied from the convention's canonical TypeScript reference.
 */

/** Clean a scalar value (the convention's single-line pattern). */
export function singleLine(text: string, opts: { flattenLineBreaks?: boolean; minify?: boolean } = {}): string {
  const { flattenLineBreaks = true, minify = false } = opts;
  if (minify) return text.replace(/\s+/g, " ").trim();
  if (flattenLineBreaks) return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return text.trim();
}

/** Clean a body whose line structure matters (the convention's multiline pattern). */
export function multiline(
  text: string,
  opts: { trimLineEnds?: boolean; dropEdgeBlankLines?: boolean; collapseBlankLines?: boolean } = {},
): string {
  const { trimLineEnds = true, dropEdgeBlankLines = true, collapseBlankLines = false } = opts;
  const isBlank = (l: string): boolean => l.trim() === "";
  let lines = text.split(/\r\n|\r|\n/);
  if (trimLineEnds) lines = lines.map((l) => l.replace(/\s+$/, ""));

  let start = 0;
  let end = lines.length;
  if (dropEdgeBlankLines) {
    while (start < end && isBlank(lines[start]!)) start++;
    while (end > start && isBlank(lines[end - 1]!)) end--;
  }

  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines.slice(start, end)) {
    const blank = isBlank(line);
    if (collapseBlankLines && blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out.join("\n");
}
