import { beforeAll } from "vitest";

// React, React DOM and Testing Library set themselves up on their first render,
// role query and event, a cost that would otherwise land in whichever test of a
// jsdom file runs first. Each jsdom file pays it once here, before its tests.
beforeAll(async () => {
  if (typeof document === "undefined") return;
  const { createElement } = await import("react");
  const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
  render(createElement("button", { type: "button" }, "warm-up"));
  fireEvent.click(screen.getByRole("button", { name: "warm-up" }));
  cleanup();
});
