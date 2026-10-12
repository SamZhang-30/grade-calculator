import { describe, expect, it } from "vitest";
import { autofillAssignmentName } from "../src/autofill";

describe("assignment-name autofill", () => {
  it("increments and decrements a trailing integer by the row offset", () => {
    expect(autofillAssignmentName("Pset2", 2)).toBe("Pset4");
    expect(autofillAssignmentName("Pset2", -2)).toBe("Pset0");
    expect(autofillAssignmentName("Pset2", -3)).toBe("Pset-1");
    expect(autofillAssignmentName("Pset10", -3)).toBe("Pset7");
  });

  it("duplicates a name without a trailing integer", () => {
    expect(autofillAssignmentName("Final project", 3)).toBe("Final project");
  });

  it("keeps useful leading zeroes", () => {
    expect(autofillAssignmentName("Quiz 008", 2)).toBe("Quiz 010");
  });
});
