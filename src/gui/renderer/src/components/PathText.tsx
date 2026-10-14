/**
 * A path as identifying text on one line (interface-styling-conventions,
 * Labels): it keeps its final segment and loses its middle, because paths in
 * one list usually share their beginning. The complete path stays in the DOM
 * for assistive technology; callers give sighted keyboard and touch users a way
 * to see it whole.
 */

/** Splits at the last separator, which stays with the final segment so the cut
 *  head reads as a parent folder. Pure, so the split is testable without a DOM. */
export function splitPath(path: string): { head: string; tail: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? { head: "", tail: path } : { head: path.slice(0, cut), tail: path.slice(cut) };
}

export function PathText({ path }: { path: string }) {
  const { head, tail } = splitPath(path);
  return (
    <span className="path-line">
      {head && <span className="path-line__head">{head}</span>}
      <span className="path-line__tail">{tail}</span>
    </span>
  );
}
