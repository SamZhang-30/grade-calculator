import { describe, expect, it } from "vitest";
import { changeTone, signedChange } from "../src/grade-display";

describe("signed grade changes", () => {
  it.each([
    [0, "0.00%", "zero"],
    [-0, "0.00%", "zero"],
    [0.000001, "+0.00%", "good"],
    [-0.000001, "−0.00%", "bad"],
    [0.02, "+2.00%", "good"],
    [-0.02, "−2.00%", "bad"],
  ] as const)("preserves the sign of %s", (value, display, tone) => {
    expect(signedChange(value)).toBe(display);
    expect(changeTone(value)).toBe(tone);
  });
});
