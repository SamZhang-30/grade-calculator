import { describe, expect, it } from "vitest";
import { summarize, type GradeCategory, type GradeEntry, type GradeStatus } from "../src/grade-engine/index.js";

/**
 * AP Lit, lifted whole out of `Grades Tracker Senior Year S2.xlsx`.
 *
 * This is the case the earlier screenshot could not test: an Exam category
 * carrying 25% of the syllabus with nothing in it at all, so both
 * renormalizations fire and every other weight moves. Raw weights are
 * 0.3375 / 0.3375 / 0.075 / 0.25, and the sheet shows the first two as 45%.
 */

let seq = 0;
const entry = (name: string, points: number | null, max: number, status: GradeStatus = "RETURNED"): GradeEntry => ({
  id: `e${seq++}`,
  name,
  points,
  max,
  status,
  sortOrder: seq,
});

const category = (name: string, weight: number, entries: GradeEntry[], sortOrder: number): GradeCategory => ({
  id: `c-${name}`,
  name,
  weightMode: "FIXED",
  weight,
  weightByMax: true, // the sheet's NORMALIZE column is FALSE on all four
  sortOrder,
  entries,
});

const apLit = (): GradeCategory[] => [
  category("Performance", 0.3375, [
    entry("Lit Terms 3", 15, 16),
    entry("Poetry FRQ1", 85, 100),
    entry("Choice FRQ3", 95, 100),
  ], 0),
  category("Process", 0.3375, [
    entry("MC PC U1", 8.5, 9),
    entry("Engage 1/9", 20, 20),
    entry("Engage 1/16", 20, 20),
    entry("MC PC U2", 7.5, 9),
    entry("Engage 1/23", 20, 20),
    entry("Engage 1/30", 15, 20),
    entry("Engage 2/6", 20, 20),
    entry("MC PC U3", 7, 9),
    entry("Engage 2/20", 20, 20),
    entry("MC PC U4", 12, 15),
    entry("Engage 2/27", 20, 20),
    entry("Iago Notes", 10, 10),
    entry("Engage 3/6", 20, 20),
    entry("Engage 3/13", null, 20, "PENDING"),
  ], 1),
  category("Homework", 0.075, [
    entry("Membean 1/18", 15, 15),
    entry("Membean 2/1", 15, 15),
    entry("Membean 2/15", 15, 15),
    entry("Membean 3/1", 15, 15),
  ], 2),
  category("Exam", 0.25, [], 3),
];

describe("AP Lit, from the workbook", () => {
  const result = summarize(apLit());
  const [performance, process, homework, exam] = result.categories;

  it("renormalizes an empty category's weight onto the rest", () => {
    // 0.3375 of a syllabus that is only 75% marked reads as 45% of the grade.
    expect(performance!.weight).toBeCloseTo(0.45, 12);
    expect(process!.weight).toBeCloseTo(0.45, 12);
    expect(homework!.weight).toBeCloseTo(0.1, 12);
    expect(exam!.weight).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain("RENORMALIZED");
  });

  it("reports an ungraded category as unknown, not as zero", () => {
    expect(exam!.percent).toBeNull();
    expect(exam!.impact).toBe(0);
  });

  it("matches the category percentages", () => {
    expect(performance!.percent).toBeCloseTo(0.9027777778, 9); // 195/216
    expect(process!.percent).toBeCloseTo(0.9433962264, 9); // 200/212
    expect(homework!.percent).toBe(1);
  });

  it("matches per-entry weights against the sheet's own cells", () => {
    expect(performance!.entries[0]!.weight).toBeCloseTo(0.03333333333, 10); // 0.45 x 16/216
    expect(performance!.entries[1]!.weight).toBeCloseTo(0.2083333333, 10);
    expect(process!.entries[0]!.weight).toBeCloseTo(0.01910377358, 10); // 0.45 x 9/212
    expect(process!.entries[1]!.weight).toBeCloseTo(0.04245283019, 10);
    expect(process!.entries[9]!.weight).toBeCloseTo(0.03183962264, 10);
    expect(performance!.entries[1]!.impact).toBeCloseTo(-0.03125, 10);
  });

  it("keeps the at-stake column on its own denominator", () => {
    // Exam has no rows at all, so it drops out of the at-stake normalization
    // too -- but Process's 20 unscored points do not: 0.45 x 20/232 = 3.88%.
    expect(process!.atStakePoints).toBe(20);
    expect(process!.atStakePercent).toBeCloseTo(0.03879310345, 10);
    expect(result.atStakePercent).toBeCloseTo(0.03879310345, 10);
    expect(performance!.atStakePercent).toBe(0);
  });

  it("matches the course average the sheet computes internally", () => {
    // Hidden!T6 = SUMPRODUCT(cur AVG, weight) = 0.9307783019.
    //
    // The sheet's own IMPACT column disagrees in the 5th decimal (-0.06921 vs
    // -0.069222) because it recomputes from the ROUNDED percentage string in
    // column B -- `(B2-1)*C2` where B2 is the text "90.28%". That is a display
    // artifact leaking into arithmetic; the engine works from the real ratio,
    // and lands on the sheet's own internal total exactly.
    expect(result.percent).toBeCloseTo(0.9307783019, 9);
    expect(result.impact).toBeCloseTo(-0.0692216981, 9);
  });
});
