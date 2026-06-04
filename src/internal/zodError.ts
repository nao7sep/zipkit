/**
 * Render a `ZodError` into a compact, human-readable string for a
 * `PolicyError` message. Each issue becomes `path: message`, dotted-path
 * style, joined with semicolons.
 */

import type { ZodError } from "zod";

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((p) => String(p)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
