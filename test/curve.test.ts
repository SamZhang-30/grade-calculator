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
