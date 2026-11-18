import { describe, expect, it } from "vitest";
import {
  applyCurve,
  evaluateCurveExpression,
  forecast,
  summarize,
  type GradeCategory,
} from "../src/grade-engine/index.js";

const category = (over: Partial<GradeCategory> = {}): GradeCategory => ({
  id: "category",
  name: "Exams",
  weightMode: "FIXED",
  weight: 1,
  weightByMax: true,
  sortOrder: 0,
  entries: [
    { id: "graded", name: "Midterm", points: 85, max: 100, status: "RETURNED", sortOrder: 0 },
    { id: "future", name: "Final", points: null, max: 100, status: "PENDING", sortOrder: 1 },
  ],
  ...over,
});

describe("category curves", () => {
  it("adds percentage points and caps at 100%", () => {
    const curved = category({
      curveEnabled: true,
      curveMode: "ADDITIVE",
      curveAddend: 15,
      curveCap: true,
    });
    const result = summarize([curved]);
    expect(result.categories[0]!.rawPercent).toBeCloseTo(0.85, 12);
    expect(result.categories[0]!.percent).toBe(1);
    expect(result.percent).toBe(1);
    expect(result.categories[0]!.entries[0]).toMatchObject({ percent: 0.85, impact: 0, finalImpact: 0 });
  });

  it.each([
    { weightByMax: true, current: [-0.02, -0.04], final: [-0.01, -0.02] },
    { weightByMax: false, current: [-0.06, -0.03], final: [-0.04, -0.02] },
  ])("shares a partially forgiven deduction by its weighted raw gap (points-based: $weightByMax)", ({
    weightByMax, current, final,
  }) => {
    const curved = category({
      weightByMax,
      curveEnabled: true,
      curveAddend: 6,
      entries: [
        { id: "short", name: "Short exam", points: 40, max: 50, status: "RETURNED", sortOrder: 0 },
        { id: "long", name: "Long exam", points: 180, max: 200, status: "ESTIMATED", sortOrder: 1 },
        { id: "future", name: "Final", points: null, max: 250, status: "PENDING", sortOrder: 2 },
      ],
    });
    const result = summarize([curved]).categories[0]!;
    current.forEach((impact, i) => expect(result.entries[i]!.impact).toBeCloseTo(impact, 12));
    final.forEach((impact, i) => expect(result.entries[i]!.finalImpact).toBeCloseTo(impact, 12));
    expect(result.entries[2]).toMatchObject({ impact: 0, finalImpact: 0 });
    expect(result.entries.reduce((sum, entry) => sum + entry.impact, 0)).toBeCloseTo(result.impact, 12);
    expect(result.entries.reduce((sum, entry) => sum + entry.finalImpact, 0)).toBeCloseTo(result.finalImpact, 12);
  });

  it("splits a bonus created by the curve using assignment weights", () => {
    const curved = category({
      curveEnabled: true,
      curveAddend: 30,
      curveCap: false,
      entries: [
        { id: "short", name: "Short exam", points: 40, max: 50, status: "RETURNED", sortOrder: 0 },
        { id: "long", name: "Long exam", points: 180, max: 200, status: "RETURNED", sortOrder: 1 },
      ],
    });
    const result = summarize([curved]).categories[0]!;
    expect(result.entries[0]!.impact).toBeCloseTo(0.036, 12);
    expect(result.entries[1]!.impact).toBeCloseTo(0.144, 12);
    expect(result.entries.reduce((sum, entry) => sum + entry.impact, 0)).toBeCloseTo(result.impact, 12);
  });

  it("nets extra credit into the category before sharing the remaining deduction", () => {
    const curved = category({
      curveEnabled: true,
      curveAddend: 0.4,
      entries: [
        { id: "short", name: "Short exam", points: 40, max: 50, status: "RETURNED", sortOrder: 0 },
        { id: "long", name: "Long exam", points: 208, max: 200, status: "RETURNED", sortOrder: 1 },
      ],
    });
    const result = summarize([curved]).categories[0]!;
    expect(result.entries[0]!.impact).toBeCloseTo(-0.004, 12);
    expect(result.entries[1]!.impact).toBeCloseTo(0, 12);
    const capped = summarize([{ ...curved, curveAddend: 2 }]).categories[0]!;
    expect(capped.entries.map((entry) => entry.impact)).toEqual([0, 0]);
  });

  it("treats a multiplier as a percentage out of 100", () => {
    expect(
      applyCurve(0.85, {
        ...category(),
        curveEnabled: true,
        curveMode: "MULTIPLICATIVE",
        curveMultiplier: 120,
        curveCap: false,
      }),
    ).toBeCloseTo(1.02, 12);
  });

  it("supports safe custom arithmetic and functions", () => {
    expect(evaluateCurveExpression("max(x + 5, sqrt(x / 100) * 100)", 64)).toEqual({
      ok: true,
      value: 80,
    });
    expect(evaluateCurveExpression("min(100, 2^3 * 12.5)", 0)).toEqual({ ok: true, value: 100 });
    expect(evaluateCurveExpression("x / 0", 50)).toMatchObject({ ok: false });
    expect(evaluateCurveExpression("window.alert(1)", 50)).toMatchObject({ ok: false });
  });

  it("keeps raw and curved forecast values side by side", () => {
    const curved = category({
      curveEnabled: true,
      curveMode: "ADDITIVE",
      curveAddend: 10,
      curveCap: false,
    });
    const summary = summarize([curved]);
    const prediction = forecast([curved], summary).categories[0]!;
    expect(prediction.expected.low).toBeCloseTo(prediction.rawExpected.low + 0.1, 12);
    expect(prediction.expected.high).toBeCloseTo(prediction.rawExpected.high + 0.1, 12);
    expect(prediction.result!.low).toBeCloseTo(prediction.rawResult!.low + 0.1, 2);
    expect(prediction.result!.high).toBeCloseTo(prediction.rawResult!.high + 0.1, 2);
  });

  it("falls back to the raw score when a custom formula is invalid", () => {
    const raw = 0.85;
    expect(
      applyCurve(raw, {
        ...category(),
        curveEnabled: true,
        curveMode: "CUSTOM",
        curveExpression: "sqrt(",
        curveCap: true,
      }),
    ).toBe(raw);
  });
});
