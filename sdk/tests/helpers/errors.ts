import { expect } from "vitest";

/** Matches a ZipKit error of kind `invalid`: the call or its inputs are wrong. */
export const invalidError = expect.objectContaining({ name: "ZipKitError", kind: "invalid" });
