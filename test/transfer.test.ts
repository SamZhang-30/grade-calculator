import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  GRADEBOOK_FORMAT,
  parseGradebook,
  serializeGradebook,
  type CurveMode,
  type ForecastBasis,
  type GradeStatus,
  type GradebookFile,
  type WeightMode,
} from "../src/grade-engine/index.js";

const file = (categories: GradebookFile["categories"]): GradebookFile => ({
  questlogGradebook: GRADEBOOK_FORMAT,
  exportedAt: "2026-08-27T12:00:00.000Z",
  categories,
});

const category = (over: Partial<GradebookFile["categories"][number]> = {}) => ({
  name: "Labs",
  weightMode: "FIXED" as WeightMode,
  weight: 0.3,
  weightByMax: true,
  alphaOverride: null,
  forecastBasis: null,
  estimateWeight: null,
  capForecast: null,
  entries: [
    { name: "Lab 1", points: 60, max: 60, status: "RETURNED" as GradeStatus, notes: null },
    { name: "Lab 2", points: null, max: 40, status: "PENDING" as GradeStatus, notes: "reschedule" },
  ],
  ...over,
});

const parsed = (f: GradebookFile) => {
  const result = parseGradebook(serializeGradebook(f));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("a gradebook survives the round trip", () => {
  it("comes back exactly as it went in", () => {
    const original = file([category()]);
    expect(parsed(original).categories).toEqual(original.categories);
  });

  it("holds every field the app can set", () => {
    const original = file([
      category({
        nameColumnWidth: 264,
        weightMode: "POOLED",
        weight: 0,
        weightByMax: false,
        alphaOverride: 0.05,
        forecastBasis: "CATEGORY" as ForecastBasis,
        estimateWeight: 0.5,
        capForecast: false,
        curveEnabled: true,
        curveMode: "CUSTOM",
        curveAddend: 12,
        curveMultiplier: 115,
        curveExpression: "max(x + 5, sqrt(x / 100) * 100)",
        curveCap: true,
      }),
    ]);
    expect(parsed(original).categories[0]).toEqual(original.categories[0]);
  });

  it("accepts the compact Name-column width", () => {
    const original = file([category({ nameColumnWidth: 80 })]);
    expect(parsed(original).categories[0]?.nameColumnWidth).toBe(80);
  });

  it("round-trips a newly inserted blank assignment", () => {
    const original = file([
      category({
        entries: [{ name: "", points: null, max: null, status: "POSSIBLE", notes: "" }],
      }),
    ]);
    expect(parsed(original).categories[0]?.entries).toEqual(original.categories[0]?.entries);
  });

  it("survives arbitrary gradebooks", () => {
    const entryArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
      points: fc.option(fc.double({ min: 0, max: 500, noNaN: true }), { nil: null }),
      max: fc.option(fc.double({ min: 1, max: 500, noNaN: true }), { nil: null }),
      status: fc.constantFrom<GradeStatus>("RETURNED", "ESTIMATED", "PENDING", "POSSIBLE"),
      notes: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
    });
    const categoryArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
      weightMode: fc.constantFrom<WeightMode>("FIXED", "POOLED"),
      weight: fc.double({ min: 0, max: 1, noNaN: true }),
      weightByMax: fc.boolean(),
      alphaOverride: fc.option(fc.double({ min: 0.01, max: 0.99, noNaN: true }), { nil: null }),
      forecastBasis: fc.option(
        fc.constantFrom<ForecastBasis>("COURSE", "COURSE_WHEN_SPARSE", "CATEGORY"),
        { nil: null },
      ),
      estimateWeight: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
      capForecast: fc.option(fc.boolean(), { nil: null }),
      curveEnabled: fc.boolean(),
      curveMode: fc.constantFrom<CurveMode>("ADDITIVE", "MULTIPLICATIVE", "CUSTOM"),
      curveAddend: fc.double({ min: -100, max: 100, noNaN: true }).filter((value) => !Object.is(value, -0)),
      curveMultiplier: fc.double({ min: 0, max: 300, noNaN: true }),
      curveExpression: fc.constantFrom("x", "x + 5", "sqrt(x / 100) * 100"),
      curveCap: fc.boolean(),
      entries: fc.array(entryArb, { maxLength: 6 }),
    });

    fc.assert(
      fc.property(fc.array(categoryArb, { maxLength: 5 }), (categories) => {
        const original = file(categories);
        expect(parsed(original).categories).toEqual(original.categories);
      }),
    );
  });
});

describe("a bad file is refused whole, with the reason", () => {
  const reject = (text: string) => {
    const result = parseGradebook(text);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.error;
  };

  it("rejects malformed JSON", () => {
    expect(reject("{ nope")).toMatch(/not valid JSON/);
  });

  it("rejects a JSON file that is not a gradebook", () => {
    expect(reject('{"hello":"world"}')).toMatch(/questlogGradebook/);
  });

  it("rejects a format it cannot read", () => {
    expect(reject('{"questlogGradebook":99,"categories":[]}')).toMatch(/format 99/);
  });

  it("names the exact row that is wrong", () => {
    const broken = JSON.parse(serializeGradebook(file([category()])));
    broken.categories[0].entries[1].max = -5;
    expect(reject(JSON.stringify(broken))).toBe(
      "categories[0].entries[1].max must be a positive number.",
    );
  });

  it("rejects an unknown status rather than guessing", () => {
    const broken = JSON.parse(serializeGradebook(file([category()])));
    broken.categories[0].entries[0].status = "GRADED";
    expect(reject(JSON.stringify(broken))).toMatch(/entries\[0\]\.status must be one of/);
  });

  it("rejects a confidence outside the range a band can exist in", () => {
    const broken = JSON.parse(serializeGradebook(file([category({ alphaOverride: 1 })])));
    expect(reject(JSON.stringify(broken))).toMatch(/alphaOverride/);
  });

  it("accepts a minimal file, filling in what it can", () => {
    const result = parseGradebook(
      JSON.stringify({ questlogGradebook: 1, categories: [{ name: "Only a name" }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const only = result.value.categories[0]!;
    expect(only).toMatchObject({
      weightMode: "FIXED",
      weight: 0,
      weightByMax: true,
      capForecast: null,
      entries: [],
    });
  });
});

describe("the settings block round-trips and is applied", () => {
  const withSettings: GradebookFile = {
    ...file([category()]),
    settings: {
      alpha: 0.4,
      basis: "CATEGORY" as ForecastBasis,
      estimateWeight: 1,
      capForecast: false,
    },
  };

  it("comes back exactly", () => {
    expect(parsed(withSettings).settings).toEqual(withSettings.settings);
  });

  it("is optional — a file without one touches nothing global", () => {
    expect(parsed(file([category()])).settings).toBeUndefined();
  });

  it("refuses a confidence a band cannot exist at", () => {
    const broken = JSON.parse(serializeGradebook({ ...withSettings, settings: { ...withSettings.settings!, alpha: 0 } }));
    const result = parseGradebook(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/settings\.alpha/);
  });

  it("refuses an unknown prediction source", () => {
    const result = parseGradebook(
      JSON.stringify({
        questlogGradebook: 1,
        categories: [],
        settings: { alpha: 0.2, basis: "VIBES", estimateWeight: 0 },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/settings\.basis/);
  });
});

describe("older files still read", () => {
  it("defaults a missing cap setting to the ceiling that used to be unconditional", () => {
    const result = parseGradebook(
      JSON.stringify({
        questlogGradebook: 1,
        categories: [{ name: "Labs" }],
        settings: { alpha: 0.2, basis: "CATEGORY", estimateWeight: 0 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settings!.capForecast).toBe(true);
    expect(result.value.categories[0]!.capForecast).toBeNull();
  });
});
