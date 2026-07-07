/**
 * The app's text-cleanup helper (text-cleanup-conventions). Per that convention
 * each app owns a small helper rather than a shared package; ZipKit needs exactly
 * one of the three patterns — `multiline`, for the archive comment (a ZIP comment
 * may legitimately span lines). It runs at commit/display time (on blur), never
 * on a keystroke, per the text-input-ime-conventions. Pure: strings in, strings
 * out, no Node/DOM, so it stays in the Node-free renderer program and is unit-
 * tested directly. Copied from the convention's canonical TypeScript snippet.
 */

/**
 * Clean a multiline body: normalize newlines to `\n`, drop each line's trailing
 * whitespace, and drop blank lines at the very start and end. Interior blank runs
 * are kept (a deliberate section break), and indentation is preserved. A line is
 * "blank" when its trimmed form is empty (so a line of spaces or a lone U+3000
 * counts), never by an `=== ""` test.
 */
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
