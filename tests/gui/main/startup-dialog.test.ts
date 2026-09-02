import { describe, expect, it } from "vitest";
import { boundedMessageDialogHeight } from "../../../src/gui/main/startup-dialog.js";

describe("boundedMessageDialogHeight", () => {
  it("opens short one-shot messages at their natural height", () => {
    expect(boundedMessageDialogHeight(260, 28)).toBe(288);
  });

  it("keeps the dialog within its usable minimum and maximum", () => {
    expect(boundedMessageDialogHeight(100, 28)).toBe(220);
    expect(boundedMessageDialogHeight(900, 28)).toBe(640);
  });
});
