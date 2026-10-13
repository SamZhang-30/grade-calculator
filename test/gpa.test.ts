import { describe, expect, it } from "vitest";
import { calculateGpa, formatGpa, gradePoints, gpaCourseResult, GPA_EXCLUDED, normalizeGpaTerms, type GpaCourse } from "../src/gpa";

const course = (grade: GpaCourse["grade"], units: number | null): GpaCourse => ({ id: "test", name: "Course", grade, units });

describe("Stanford GPA", () => {
  it("displays GPA with exactly four decimal places", () => {
    expect(formatGpa(3.28)).toBe("3.2800");
    expect(formatGpa(23 / 6)).toBe("3.8333");
    expect(formatGpa(4.3)).toBe("4.3000");
    expect(formatGpa(0)).toBe("0.0000");
    expect(formatGpa(null)).toBe("N/A");
  });
  it("matches Stanford's published 3.28 example", () => {
    const result = calculateGpa([course("B-", 3), course("A-", 4), course("B+", 3)]);
    expect(result.gpa).toBeCloseTo(3.28, 12);
    expect(result.units).toBe(10);
    expect(result.qualityPoints).toBeCloseTo(32.8, 12);
  });
  it("includes NP in the denominator, but excludes NC", () => {
    expect(calculateGpa([course("A", 4), course("NP", 4)]).gpa).toBe(2);
    expect(calculateGpa([course("A", 4), course("NC", 4)]).gpa).toBe(4);
    expect(calculateGpa([course("NP", 4)]).gpa).toBe(0);
  });
  it("uses A+ 4.3, L 2.0, and Stanford's GSB conversions", () => {
    expect(gradePoints("A+")).toBe(4.3);
    expect(gradePoints("L")).toBe(2);
    expect(gradePoints("D-")).toBe(.7);
    expect(["H", "HP", "P", "LP", "U"].map((grade) => gradePoints(`GSB:${grade}`)))
      .toEqual([4.14, 3.54, 3.24, 2.94, 0]);
  });
  it.each(GPA_EXCLUDED)("excludes %s from both numerator and denominator", (grade) => {
    expect(calculateGpa([course("A", 5), course(grade, 100)]))
      .toEqual({ gpa: 4, units: 5, qualityPoints: 20, countedCourses: 1 });
  });
  it("excludes blank grades, missing, nonpositive, and nonfinite units", () => {
    expect(calculateGpa([course("", 4), course("A", null)])).toEqual({ gpa: null, units: 0, qualityPoints: 0, countedCourses: 0 });
    for (const units of [0, -1, NaN, Infinity]) expect(gpaCourseResult(course("A", units)).counted).toBe(false);
    expect(gradePoints("toString")).toBeNull();
  });
  it("weights terms by course units, not by averaging term GPAs", () => {
    expect(calculateGpa([course("A", 5), course("B", 1)]).gpa).toBeCloseTo(23 / 6, 12);
    expect(calculateGpa([course("A+", .5), course("NP", .5)]).gpa).toBe(2.15);
  });
  it("does not deduplicate repeated names; transcript RP controls exclusion", () => {
    expect(calculateGpa([course("RP", 3), course("B", 3)]).gpa).toBe(3);
    expect(calculateGpa([course("A", 3), course("B", 3)]).gpa).toBe(3.5);
  });
  it("normalizes old or invalid data without inventing counted results", () => {
    expect(normalizeGpaTerms(undefined)).toEqual([]);
    expect(normalizeGpaTerms([{ id: "term", name: "Autumn", courses: [
      { id: "a", name: "Class", grade: "bad", units: -1 },
      { id: "a", name: "Duplicate ID", grade: "A", units: 5 },
      null,
    ] }])).toEqual([{ id: "term", name: "Autumn", courses: [{ id: "a", name: "Class", grade: "", units: null }] }]);
  });
});
