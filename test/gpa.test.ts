import { describe, expect, it } from "vitest";
import { calculateGpa, formatGpa, gradePoints, gpaCourseResult, parseGpaUnits, totalCoursework, GPA_EXCLUDED, normalizeGpaTerms, type GpaCourse } from "../src/gpa";

const course = (grade: GpaCourse["grade"], units: number | null): GpaCourse => ({ id: "test", name: "Course", grade, units });

describe("Stanford GPA", () => {
  it("reports total coursework separately from GPA-counted units", () => {
    const courses = [course("A", 5), course("CR", 3), course("", 2), course("NP", 4), course("A", null)];
    expect(totalCoursework(courses)).toEqual({ units: 14, courseCount: 4 });
    expect(calculateGpa(courses).units).toBe(9);
    expect(totalCoursework([course("S", 1)])).toEqual({ units: 1, courseCount: 1 });
    expect(totalCoursework([course("A", 0), course("A", -1), course("A", NaN), course("A", Infinity)]))
      .toEqual({ units: 0, courseCount: 1 });
  });
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
  it("excludes blank grades, missing, negative, fractional, and nonfinite units", () => {
    expect(calculateGpa([course("", 4), course("A", null)])).toEqual({ gpa: null, units: 0, qualityPoints: 0, countedCourses: 0 });
    for (const units of [-1, .5, NaN, Infinity]) expect(gpaCourseResult(course("A", units)).counted).toBe(false);
    expect(gradePoints("toString")).toBeNull();
  });
  it("weights terms by course units, not by averaging term GPAs", () => {
    expect(calculateGpa([course("A", 5), course("B", 1)]).gpa).toBeCloseTo(23 / 6, 12);
    expect(calculateGpa([course("A+", 1), course("NP", 1)]).gpa).toBe(2.15);
  });
  it("accepts zero units without dividing by zero or changing a positive-unit GPA", () => {
    const zero = course("A", 0);
    expect(gpaCourseResult(zero)).toEqual({ points: 4, counted: true, units: 0, qualityPoints: 0 });
    expect(calculateGpa([zero])).toEqual({ gpa: null, units: 0, qualityPoints: 0, countedCourses: 1 });
    expect(calculateGpa([zero, course("B", 3)]).gpa).toBe(3);
  });
  it("parses only nonnegative whole-number unit input", () => {
    expect(parseGpaUnits("0")).toBe(0);
    expect(parseGpaUnits(" 005 ")).toBe(5);
    expect(parseGpaUnits(" ")).toBeNull();
    for (const value of ["-1", "-0", "1.5", "1.0", "1e3", "NaN", "Infinity", "abc", "9007199254740992"]) {
      expect(parseGpaUnits(value)).toBeUndefined();
    }
  });
  it("preserves zero and existing fractional units on read, but excludes fractions from calculations", () => {
    const terms = normalizeGpaTerms([{ id: "term", name: "Term", courses: [
      { ...course("A", 0), id: "zero" }, { ...course("A", 1.5), id: "fraction" },
    ] }]);
    expect(terms[0]!.courses.map((item) => item.units)).toEqual([0, 1.5]);
    expect(calculateGpa(terms[0]!.courses).gpa).toBeNull();
    expect(totalCoursework(terms[0]!.courses)).toEqual({ units: 0, courseCount: 1 });
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
