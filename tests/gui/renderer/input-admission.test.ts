import { describe, expect, it } from "vitest";

import { planInputAdmission } from "../../../src/gui/renderer/src/inputAdmission";

describe("input admission", () => {
  it("keeps first-seen order and reports existing and repeated literal paths", () => {
    expect(planInputAdmission(
      ["/existing"],
      ["/new-a", "/existing", "/new-b", "/new-a", ""],
    )).toEqual({ accepted: ["/new-a", "/new-b"], duplicates: 2 });
  });

  it("allows the same path in a distinct empty collection", () => {
    expect(planInputAdmission([], ["/existing"])).toEqual({
      accepted: ["/existing"],
      duplicates: 0,
    });
  });
});
