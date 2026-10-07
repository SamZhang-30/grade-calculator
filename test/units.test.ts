import { describe, expect, it } from "vitest";
import { formatUnits, unitInputValue } from "../src/units.js";

describe("course units", () => {
  it("formats singular and plural labels", () => {
    expect(formatUnits("1")).toBe("1 unit");
    expect(formatUnits("2")).toBe("2 units");
    expect(formatUnits("0")).toBe("0 units");
  });

  it("normalizes legacy unit strings for the integer editor", () => {
    expect(unitInputValue("5 units")).toBe("5");
    expect(formatUnits("5 units")).toBe("5 units");
    expect(unitInputValue("not set")).toBe("");
  });
});
