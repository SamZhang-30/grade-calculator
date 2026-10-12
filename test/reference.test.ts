import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRADE_CONFIG,
  summarize,
  type GradeCategory,
  type GradeEntry,
  type GradeStatus,
} from "../src/grade-engine/index.js";

/**
 * The sheet this feature replaces, reproduced row for row.
 *
 * Every number asserted here was read off the original Google Sheet, not
 * produced by this code. If the engine and the spreadsheet ever disagree, one
 * of them is wrong and this test is where it shows up.
 *
 * Midterms and Project are entered as their point totals rather than their
 * individual rows -- the summary screenshot shows the category totals only, and
 * a category is indistinguishable from the sum of its parts under
 * points-proportional weighting (which `splitting is invisible` proves).
 */

let seq = 0;
const entry = (name: string, points: number | null, max: number, status: GradeStatus): GradeEntry => ({
  id: `e${seq++}`,
  name,
  points,
  max,
  status,
  sortOrder: seq,
});

const category = (
  name: string,
  weight: number,
  entries: GradeEntry[],
  sortOrder: number,
): GradeCategory => ({
  id: `c-${name}`,
  name,
  weightMode: "FIXED",
  weight,
  weightByMax: true,
  sortOrder,
  entries,
});

function sheet(): GradeCategory[] {
  const participation = [
    ...Array.from({ length: 11 }, (_, i) =>
      entry(`DN${String(i + 1).padStart(2, "0")}`, 10, 10, "RETURNED"),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      entry(`DN${String(i + 12).padStart(2, "0")}`, null, 10, "PENDING"),
    ),
  ];

  const labs = [
    entry("Lab 1", 60, 60, "RETURNED"),
    entry("Lab 2", 40, 40, "RETURNED"),
    entry("Lab 3", 30, 30, "RETURNED"),
    entry("Lab 4", 44, 40, "RETURNED"),
    entry("Lab 5", 35, 35, "RETURNED"),
    entry("Lab 6", 15, 15, "RETURNED"),
  ];

  return [
    category("Participation", 0.2, participation, 0),
    category("Labs", 0.3, labs, 1),
    category("Midterms", 0.3, [entry("Midterms", 201, 220, "RETURNED")], 2),
    category("Project", 0.2, [
      entry("Project (graded)", 93, 110, "RETURNED"),
      entry("Project (remaining)", null, 20, "PENDING"),
    ], 3),
  ];
}

const pct = (x: number | null) => (x === null ? null : Number((x * 100).toFixed(2)));

describe("the original spreadsheet", () => {
  const result = summarize(sheet(), {
    ...DEFAULT_GRADE_CONFIG,
    currentGradeWeighting: "CATEGORY_PROGRESS",
  });
  const [participation, labs, midterms, project] = result.categories;

  it("matches every category percentage", () => {
    expect(pct(participation!.percent)).toBe(100.0);
    expect(pct(labs!.percent)).toBe(101.82);
    expect(pct(midterms!.percent)).toBe(91.36);
    expect(pct(project!.percent)).toBe(84.55);
  });

  it("matches every impact", () => {
    expect(pct(participation!.impact)).toBe(0.0);
    expect(pct(labs!.impact)).toBe(0.55);
    expect(pct(midterms!.impact)).toBe(-2.59);
    expect(pct(project!.impact)).toBe(-3.09);
  });

  it("matches the at-stake column, in points and in percent", () => {
    expect(participation!.atStakePoints).toBe(30);
    expect(pct(participation!.atStakePercent)).toBe(4.29);
    expect(labs!.atStakePoints).toBe(0);
    expect(project!.atStakePoints).toBe(20);
    expect(pct(project!.atStakePercent)).toBe(3.08);
    expect(pct(result.atStakePercent)).toBe(7.36);
  });

  it("matches the total row", () => {
    expect(pct(result.percent)).toBe(94.86);
    expect(pct(result.impact)).toBe(-5.14);
  });

  it("matches per-assignment weights inside a category", () => {
    // 30% x 60/220 -- the labs share their weight by point value.
    expect(pct(labs!.entries[0]!.weight)).toBe(8.18);
    expect(pct(labs!.entries[1]!.weight)).toBe(5.45);
    expect(pct(labs!.entries[5]!.weight)).toBe(2.05);
    // Lab 4 scored 44/40, and that 10% overshoot moves the course grade 0.55%.
    expect(pct(labs!.entries[3]!.impact)).toBe(0.55);
  });

  it("spreads participation over the ELEVEN graded slots, not all fourteen", () => {
    // 20% / 11 = 1.82%, summing to the full 20% -- while 30 unscored points
    // still read as 4.29% at stake. Two questions, two denominators.
    expect(pct(participation!.entries[0]!.weight)).toBe(1.82);
    expect(pct(participation!.weight)).toBe(20.0);
  });

  it("raises no warnings on a well-formed sheet", () => {
    expect(result.warnings).toEqual([]);
  });
});
