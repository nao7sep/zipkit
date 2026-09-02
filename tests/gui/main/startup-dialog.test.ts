import { describe, expect, it } from "vitest";
import {
  boundedMessageDialogHeight,
  buildAppMessageDialogDocument,
} from "../../../src/gui/main/startup-dialog.js";

describe("boundedMessageDialogHeight", () => {
  it("opens short one-shot messages at their natural height", () => {
    expect(boundedMessageDialogHeight(260, 28)).toBe(288);
  });

  it("keeps the dialog within its usable minimum and maximum", () => {
    expect(boundedMessageDialogHeight(100, 28)).toBe(220);
    expect(boundedMessageDialogHeight(900, 28)).toBe(640);
  });
});

describe("app message dialog document", () => {
  it("pins header and footer while only the body can scroll", () => {
    const html = buildAppMessageDialogDocument("Could not start", "line\n".repeat(1_000), "Quit");

    expect(html).toContain("html,body{height:100%;margin:0;overflow:hidden}");
    expect(html).toContain("body{display:flex;flex-direction:column");
    expect(html).toContain("h1{flex:0 0 auto");
    expect(html).toContain(".body{min-height:0;flex:1 1 auto;overflow:auto");
    expect(html).toContain(".footer{flex:0 0 auto");
    expect(html.indexOf('<div class="body">')).toBeLessThan(html.indexOf('<div class="footer">'));
    expect(html).toContain(">Quit</button>");
  });

  it("escapes authored copy without changing the fixed shell", () => {
    const html = buildAppMessageDialogDocument("<Title>", "hostile </div><script>", "OK");

    expect(html).not.toContain("<Title>");
    expect(html).not.toContain("hostile </div><script>");
    expect(html).toContain("&lt;Title&gt;");
    expect(html).toContain("hostile &lt;/div&gt;&lt;script&gt;");
  });
});
