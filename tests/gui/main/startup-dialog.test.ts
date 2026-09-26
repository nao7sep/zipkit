import { describe, expect, it } from "vitest";
import {
  boundedMessageDialogHeight,
  buildAppMessageDialogDocument,
  type AppMessageDialogText,
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

function text(over: Partial<AppMessageDialogText>): AppMessageDialogText {
  return {
    lang: "en",
    title: "Could not start",
    message: "message",
    buttonLabel: "Quit",
    regionLabel: "Could not start: details",
    ...over,
  };
}

describe("app message dialog document", () => {
  it("pins header and footer while only the body can scroll", () => {
    const html = buildAppMessageDialogDocument(text({ message: "line\n".repeat(1_000) }));

    expect(html.indexOf('<div class="body"')).toBeLessThan(html.indexOf('<div class="footer">'));
    expect(html).toContain('role="region" aria-label="Could not start: details" tabindex="0"');
    expect(html).toContain("*::-webkit-scrollbar{width:16px;height:16px}");
    expect(html).toContain(">Quit</button>");
  });

  it("follows the resolved theme: light by default, dark under prefers-color-scheme", () => {
    const html = buildAppMessageDialogDocument(text({}));
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("body{display:flex;flex-direction:column;background:#f3f2ea;");
    expect(html).toContain("@media (prefers-color-scheme:dark){");
  });

  it("escapes authored copy without changing the fixed shell", () => {
    const html = buildAppMessageDialogDocument(text({ title: "<Title>", message: "hostile </div><script>" }));

    expect(html).not.toContain("<Title>");
    expect(html).not.toContain("hostile </div><script>");
    expect(html).toContain("&lt;Title&gt;");
    expect(html).toContain("hostile &lt;/div&gt;&lt;script&gt;");
  });

  it("declares the interface language and draws its words", () => {
    const html = buildAppMessageDialogDocument(text({
      lang: "ja",
      title: "ZipKit を起動できませんでした",
      buttonLabel: "終了",
      regionLabel: "ZipKit を起動できませんでした: 詳細",
    }));

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain(">終了</button>");
    expect(html).toContain('aria-label="ZipKit を起動できませんでした: 詳細"');
  });
});
