import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_GRADE_CONFIG,
  FREQUENTIST_PRIOR,
  effectiveSampleSize,
  forecast,
  studentTCdf,
  studentTQuantile,
  summarize,
  weightedVariance,
  type GradeCategory,
  type GradeEntry,
  type GradeStatus,
} from "../src/grade-engine/index.js";

/** The same AP Lit sheet, now checked against its forecast cells. */
let seq = 0;
const entry = (name: string, points: number | null, max: number, status: GradeStatus = "RETURNED"): GradeEntry => ({
  id: `f${seq++}`,
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
  weightByMax: true,
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

describe("Student's t", () => {
  it("matches published table values", () => {
    // The sheet's own t_crit cells: T.INV(0.9, 1) and T.INV(0.9, 8).
    expect(studentTQuantile(0.9, 1)).toBeCloseTo(3.077683537, 8);
    expect(studentTQuantile(0.9, 8)).toBeCloseTo(1.396815, 6);
    expect(studentTQuantile(0.9, 10)).toBeCloseTo(1.372184, 6);
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.7062047, 6);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228138852, 8);
    expect(studentTQuantile(0.95, 30)).toBeCloseTo(1.697260887, 8);
  });

  it("round-trips against its own CDF", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        fc.integer({ min: 1, max: 200 }),
        (p, df) => {
          expect(studentTCdf(studentTQuantile(p, df), df)).toBeCloseTo(p, 9);
        },
      ),
    );
  });

  it("is symmetric and monotone in df toward the normal", () => {
    expect(studentTQuantile(0.5, 7)).toBe(0);
    expect(studentTQuantile(0.3, 7)).toBeCloseTo(-studentTQuantile(0.7, 7), 10);
    // Heavier tails at low df, converging on the normal z = 1.959964 from
    // ABOVE -- t is always the wider of the two, even at df = 100000.
    expect(studentTQuantile(0.975, 2)).toBeGreaterThan(studentTQuantile(0.975, 20));
    expect(studentTQuantile(0.975, 100000)).toBeGreaterThan(1.959964);
    expect(studentTQuantile(0.975, 100000)).toBeCloseTo(1.959964, 4);
  });
});

describe("weighted variance", () => {
  it("collapses to the ordinary unbiased variance when weights are equal", () => {
    const values = [0.9, 0.8, 1, 0.75];
    const mean = values.reduce((a, b) => a + b) / values.length;
    const unbiased = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
    expect(weightedVariance(values, [1, 1, 1, 1])).toBeCloseTo(unbiased, 12);
    // ...and is invariant to the scale of the weights.
    expect(weightedVariance(values, [7, 7, 7, 7])).toBeCloseTo(unbiased, 12);
  });

  it("is zero for a single row, however it is weighted", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0.01, max: 99, noNaN: true }), (v, w) => {
        expect(weightedVariance([v], [w])).toBe(0);
        expect(effectiveSampleSize([w])).toBeCloseTo(1, 12);
      }),
    );
  });

  it("is never negative", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: 0, max: 1.2, noNaN: true }), fc.double({ min: 0.01, max: 50, noNaN: true })), { minLength: 1, maxLength: 12 }),
        (rows) => {
          expect(weightedVariance(rows.map((r) => r[0]), rows.map((r) => r[1]))).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

/**
 * Spreadsheet parity mode.
 *
 * The workbook has no prior -- it goes straight to the sample variance -- so
 * reproducing it means asking for the non-informative prior explicitly. That
 * the shipping engine no longer defaults to this is the improvement; that it
 * can still be asked for is what keeps the workbook usable as a reference.
 */
const PARITY = {
  ...DEFAULT_GRADE_CONFIG,
  forecastPrior: FREQUENTIST_PRIOR,
  defaultBasis: "CATEGORY" as const,
};

describe("AP Lit's forecast, against the workbook", () => {
  const categories = apLit();
  const summary = summarize(categories, PARITY);
  const result = forecast(categories, summary, PARITY);
  const [performance, process] = result.categories;

  it("matches the STD. DEV. column", () => {
    expect(performance!.sd).toBeCloseTo(0.06527912098, 10);
    expect(process!.sd).toBeCloseTo(0.0987230387, 10);
    expect(result.sd).toBeCloseTo(0.08203360056, 10);
  });

  it("matches the effective sample sizes and band widths", () => {
    expect(performance!.effectiveSampleSize).toBeCloseTo(2.303317536, 8);
    expect(performance!.band).toBeCloseTo(0.2406004934, 9);
    expect(result.effectiveSampleSize).toBeCloseTo(9.311525043, 8);
    expect(result.band).toBeCloseTo(0.1205818112, 9);
  });

  it("matches the EXPECTED column", () => {
    expect(performance!.expected.low * 100).toBeCloseTo(66.21772843, 7); // "66-100"
    expect(performance!.expected.high).toBe(1);
    expect(Math.round(process!.expected.low * 100)).toBe(80); // "80-100"
    expect(result.expected.low * 100).toBeCloseTo(81.01964907, 7); // "81-100"
  });

  it("matches the RESULT column", () => {
    // Process: 20 points outstanding, projected 16-20 of them earned.
    expect(process!.result!.low).toBeCloseTo(0.9310345, 7); // 216/232 -> 93
    expect(process!.result!.high).toBeCloseTo(0.9482759, 7); // 220/232 -> 95
    expect(result.result!.low).toBeCloseTo(0.9252155172, 9);
    expect(result.result!.high).toBeCloseTo(0.9329741379, 9);
  });

  it("matches STAND TO GAIN and STAND TO LOSE", () => {
    expect(process!.standToGain).toBeCloseTo(0.002195836044, 10);
    expect(process!.standToLose).toBeCloseTo(-0.005562784645, 10);
    // Process is the only category with work outstanding, so it IS the course.
    expect(result.standToGain).toBeCloseTo(0.002195836044, 10);
    expect(result.standToLose).toBeCloseTo(-0.005562784645, 10);
    // Nothing outstanding anywhere else means nothing to gain or lose there.
    expect(performance!.standToGain).toBe(0);
    expect(performance!.standToLose).toBe(0);
  });
});

describe("forecast invariants", () => {
  const arb = fc
    .array(
      fc.record({
        weight: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
        weightByMax: fc.boolean(),
        entries: fc.array(
          fc.record({
            max: fc.double({ min: 1, max: 200, noNaN: true }),
            ratio: fc.oneof(
      // The domain is [0, +inf): a score is points over points possible, and
      // nothing stops a category awarding more than it asks for. The upper
      // bound here is not a rule the engine knows -- every invariant below is
      // scale-free and holds identically at 5000% -- it exists only because
      // fast-check needs a finite range to sample. Weighted so the ordinary
      // 0-100% case still gets most of the draws while extra credit, the case
      // that hid the clamp bug, shows up often enough to matter.
      { arbitrary: fc.double({ min: 0, max: 1.2, noNaN: true }), weight: 4 },
      { arbitrary: fc.double({ min: 1, max: 50, noNaN: true }), weight: 1 },
    ),
            scored: fc.boolean(),
            status: fc.constantFrom<GradeStatus>("RETURNED", "ESTIMATED", "PENDING", "POSSIBLE"),
          }),
          { maxLength: 8 },
        ),
      }),
      { minLength: 1, maxLength: 4 },
    )
    .map((cats) =>
      cats.map(
        (c, i): GradeCategory => ({
          id: `c${i}`,
          name: `Category ${i}`,
          weightMode: "FIXED",
          weight: c.weight,
          weightByMax: c.weightByMax,
          sortOrder: i,
          entries: c.entries.map(
            (e, j): GradeEntry => ({
              id: `c${i}e${j}`,
              name: `Entry ${j}`,
              points: e.scored ? e.ratio * e.max : null,
              max: e.max,
              status: e.status,
              sortOrder: j,
            }),
          ),
        }),
      ),
    );

  it("always produces a well-formed interval, extra credit included", () => {
    fc.assert(
      fc.property(arb, (sheet) => {
        const summary = summarize(sheet);
        const f = forecast(sheet, summary);
        f.categories.forEach((c, i) => {
          expect(c.expected.low).toBeGreaterThanOrEqual(0);
          // Never backwards. This is the invariant the old `high <= 1` hid: a
          // category averaging above 100 had its band clamped BELOW its own
          // centre, so low overtook high.
          expect(c.expected.low).toBeLessThanOrEqual(c.expected.high);
          if (c.result) expect(c.result.low).toBeLessThanOrEqual(c.result.high + 1e-12);

          // These categories take the default, which is a hard [0, 100] --
          // however far above 100 the category itself is standing.
          expect(c.expected.high).toBeLessThanOrEqual(1);
        });
        expect(f.expected.low).toBeGreaterThanOrEqual(0);
        expect(f.expected.low).toBeLessThanOrEqual(f.expected.high);
        expect(f.expected.high).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("cannot stand to lose by finishing, or gain by failing", () => {
    fc.assert(
      fc.property(arb, (sheet) => {
        const f = forecast(sheet, summarize(sheet));
        for (const c of f.categories) {
          expect(c.standToGain).toBeGreaterThanOrEqual(c.standToLose - 1e-12);
        }
        expect(f.standToGain).toBeGreaterThanOrEqual(f.standToLose - 1e-12);
      }),
    );
  });

  it("has nothing to say about a course with nothing outstanding", () => {
    fc.assert(
      fc.property(arb, (sheet) => {
        const settled = sheet.map((c) => ({
          ...c,
          entries: c.entries.filter((e) => e.status === "RETURNED" && e.points !== null),
        }));
        const summary = summarize(settled);
        if (summary.percent === null) return;
        const f = forecast(settled, summary);
        expect(f.standToGain).toBe(0);
        expect(f.standToLose).toBe(0);
      }),
    );
  });
});

describe("gain and lose decompose", () => {
  /**
   * The column has to add up.
   *
   * Each category's figure is the move ITS OWN outstanding work can cause, so
   * the categories together must account for the whole course's swing. The
   * spreadsheet's version does not: it assumes unmarked categories score 100%,
   * which puts a constant on every row and makes categories with nothing
   * outstanding report a swing they cannot cause.
   */
  const arb = fc
    .array(
      fc.record({
        weight: fc.integer({ min: 1, max: 100 }).map((n) => n / 100),
        weightByMax: fc.boolean(),
        // POOLED matters here: a pooled category's share of the CURRENT grade
        // is proportional to its graded points while its share of the FINAL
        // grade is proportional to its whole roster, and those two are not
        // proportional to each other. Generating only FIXED categories hid
        // exactly that.
        weightMode: fc.constantFrom<"FIXED" | "POOLED">("FIXED", "POOLED"),
        entries: fc.array(
          fc.record({
            max: fc.double({ min: 1, max: 200, noNaN: true }),
            ratio: fc.oneof(
      // The domain is [0, +inf): a score is points over points possible, and
      // nothing stops a category awarding more than it asks for. The upper
      // bound here is not a rule the engine knows -- every invariant below is
      // scale-free and holds identically at 5000% -- it exists only because
      // fast-check needs a finite range to sample. Weighted so the ordinary
      // 0-100% case still gets most of the draws while extra credit, the case
      // that hid the clamp bug, shows up often enough to matter.
      { arbitrary: fc.double({ min: 0, max: 1.2, noNaN: true }), weight: 4 },
      { arbitrary: fc.double({ min: 1, max: 50, noNaN: true }), weight: 1 },
    ),
            scored: fc.boolean(),
            status: fc.constantFrom<GradeStatus>("RETURNED", "ESTIMATED", "PENDING", "POSSIBLE"),
          }),
          { maxLength: 6 },
        ),
      }),
      { minLength: 1, maxLength: 4 },
    )
    .map((cats) =>
      cats.map(
        (c, i): GradeCategory => ({
          id: `c${i}`,
          name: `Category ${i}`,
          weightMode: c.weightMode,
          weight: c.weight,
          weightByMax: c.weightByMax,
          sortOrder: i,
          entries: c.entries.map(
            (e, j): GradeEntry => ({
              id: `c${i}e${j}`,
              name: `Entry ${j}`,
              points: e.scored ? e.ratio * e.max : null,
              max: e.max,
              status: e.status,
              sortOrder: j,
            }),
          ),
        }),
      ),
    );

  it("category figures sum to the course figure", () => {
    fc.assert(
      fc.property(arb, (sheet) => {
        const summary = summarize(sheet);
        const f = forecast(sheet, summary);
        if (summary.percent === null) return;

        // The deadzone rounds each figure independently, so allow one deadzone
        // per row plus one for the total.
        const slack = 1e-4 * (f.categories.length + 1);
        const gain = f.categories.reduce((s, c) => s + c.standToGain, 0);
        const lose = f.categories.reduce((s, c) => s + c.standToLose, 0);
        expect(Math.abs(gain - f.standToGain)).toBeLessThanOrEqual(slack);
        expect(Math.abs(lose - f.standToLose)).toBeLessThanOrEqual(slack);
      }),
    );
  });

  it("a category with nothing outstanding reports nothing", () => {
    fc.assert(
      fc.property(arb, (sheet) => {
        const summary = summarize(sheet);
        const f = forecast(sheet, summary);
        f.categories.forEach((c, i) => {
          const outstanding = summary.categories[i]!.atStakePoints > 0;
          if (!outstanding) {
            expect(c.standToGain).toBe(0);
            expect(c.standToLose).toBe(0);
          }
        });
      }),
    );
  });
});

describe("the prior stops a small sample claiming certainty", () => {
  const category = (entries: GradeEntry[]): GradeCategory[] => [
    {
      id: "c",
      name: "Quizzes",
      weightMode: "FIXED",
      weight: 1,
      weightByMax: true,
      forecastBasis: "CATEGORY",
      sortOrder: 0,
      entries,
    },
  ];
  const mark = (i: number, ratio: number): GradeEntry => ({
    id: `q${i}`,
    name: `Quiz ${i}`,
    points: ratio * 100,
    max: 100,
    status: "RETURNED",
    sortOrder: i,
  });
  /** n marks all scoring exactly k, plus one still to come. */
  const run = (n: number, k: number) => {
    const entries = [
      ...Array.from({ length: n }, (_, i) => mark(i, k)),
      { id: "next", name: "Next quiz", points: null, max: 100, status: "PENDING" as const, sortOrder: 99 },
    ];
    const cats = category(entries);
    return forecast(cats, summarize(cats)).categories[0]!;
  };

  it("gives ONE observation a real interval instead of a point", () => {
    const one = run(1, 0.9);
    expect(one.sd).toBe(0); // no sample spread exists...
    expect(one.band).toBeGreaterThan(0); // ...but the prior still has a width
    expect(one.expected.low).toBeLessThan(one.expected.high);
  });

  it("narrows around k as identical marks pile up, without ever reaching a point", () => {
    const widths = [1, 2, 4, 8, 16, 32].map((n) => run(n, 0.9).band);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
      expect(widths[i]!).toBeGreaterThan(0);
    }
    // Every mark is exactly 90%, so the sample variance stays zero throughout:
    // the contraction comes entirely from the prior being outvoted.
    expect(run(32, 0.9).sd).toBeCloseTo(0, 12);
    // ...and it contracts at the 1/sqrt(n) rate: 4x the marks, half the width.
    expect(run(32, 0.9).band / run(8, 0.9).band).toBeCloseTo(0.5, 1);
  });

  it("centres on k once the marks outweigh the prior", () => {
    expect(run(32, 0.9).expected.low).toBeCloseTo(0.9, 1);
    expect(run(32, 0.9).expected.high).toBeCloseTo(0.9, 1);
  });

  it("falls back to the course when a category has nothing of its own", () => {
    const cats: GradeCategory[] = [
      {
        id: "hw",
        name: "Homework",
        weightMode: "FIXED",
        weight: 0.5,
        weightByMax: true,
        sortOrder: 0,
        entries: [mark(1, 0.8), mark(2, 0.9), mark(3, 0.85)],
      },
      {
        id: "exam",
        name: "Exam",
        weightMode: "FIXED",
        weight: 0.5,
        weightByMax: true,
        forecastBasis: "COURSE_WHEN_SPARSE",
        sortOrder: 1,
        entries: [{ id: "e1", name: "Final", points: null, max: 100, status: "PENDING", sortOrder: 0 }],
      },
    ];
    const exam = forecast(cats, summarize(cats)).categories[1]!;
    // With no marks of its own it would otherwise span 0-100. Borrowing the
    // course's three marks gives it a real band around the course average.
    expect(exam.expected.low).toBeGreaterThan(0.4);
    expect(exam.expected.high).toBeLessThanOrEqual(1);

    const alone = forecast(
      cats.map((c) => (c.id === "exam" ? { ...c, forecastBasis: "CATEGORY" as const } : c)),
      summarize(cats),
    ).categories[1]!;
    expect(alone.expected).toEqual({ low: 0, high: 1 });
  });

  it("takes a per-category confidence override", () => {
    const cats = category([mark(1, 0.8), mark(2, 0.95), mark(3, 0.85)]);
    const wide = forecast(
      cats.map((c) => ({ ...c, alphaOverride: 0.01 })),
      summarize(cats),
    ).categories[0]!;
    const narrow = forecast(
      cats.map((c) => ({ ...c, alphaOverride: 0.5 })),
      summarize(cats),
    ).categories[0]!;
    expect(wide.band).toBeGreaterThan(narrow.band);
  });
});

describe("pooling does not break the decomposition", () => {
  /**
   * The concrete case that caught it.
   *
   * Two pooled categories with DIFFERENT proportions marked: Participation has
   * 120 of 140 points back, Midterms has all 220. Their shares of the current
   * grade go by graded points (120/340, 220/340) while their shares of the
   * final grade go by whole rosters (140/360, 220/360) -- not proportional, so
   * any baseline built from one and compared against the other leaks a
   * constant into every row.
   */
  const sheet = (): GradeCategory[] => [
    {
      id: "participation",
      name: "Participation",
      weightMode: "POOLED",
      weight: 0,
      weightByMax: true,
      sortOrder: 0,
      entries: [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `p${i}`,
          name: `Day ${i}`,
          points: 10,
          max: 10,
          status: "RETURNED" as const,
          sortOrder: i,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          id: `pp${i}`,
          name: `Day ${12 + i}`,
          points: null,
          max: 10,
          status: "PENDING" as const,
          sortOrder: 12 + i,
        })),
      ],
    },
    {
      id: "midterms",
      name: "Midterms",
      weightMode: "POOLED",
      weight: 0,
      weightByMax: true,
      sortOrder: 1,
      entries: [
        { id: "m1", name: "Midterms", points: 201, max: 220, status: "RETURNED", sortOrder: 0 },
      ],
    },
    {
      id: "exams",
      name: "Exams",
      weightMode: "FIXED",
      weight: 0.5,
      weightByMax: true,
      sortOrder: 2,
      entries: [{ id: "e1", name: "Final", points: 95, max: 100, status: "RETURNED", sortOrder: 0 }],
    },
  ];

  const categories = sheet();
  const summary = summarize(categories);
  const f = forecast(categories, summary);

  it("splits the residual by graded points for the grade and by roster for the final", () => {
    expect(summary.pooledResidual).toBeCloseTo(0.5, 12);
    expect(summary.categories[0]!.gradedPoints).toBe(120);
    expect(summary.categories[1]!.gradedPoints).toBe(220);
    // Current grade: 120/340 of the residual. Final grade: 140/360 of it.
    expect(summary.categories[0]!.weight).toBeCloseTo((0.5 * 120) / 340, 10);
    expect(summary.categories[0]!.syllabusWeight).toBeCloseTo((0.5 * 140) / 360, 10);
  });

  it("still attributes a swing only to the category that can cause one", () => {
    expect(f.categories[1]!.standToGain).toBe(0); // Midterms: nothing outstanding
    expect(f.categories[1]!.standToLose).toBe(0);
    expect(f.categories[2]!.standToGain).toBe(0); // Exams: nothing outstanding
    expect(f.categories[2]!.standToLose).toBe(0);
    expect(f.categories[0]!.standToLose).toBeLessThan(0); // Participation can slip
  });

  it("still adds up", () => {
    const gain = f.categories.reduce((s, c) => s + c.standToGain, 0);
    const lose = f.categories.reduce((s, c) => s + c.standToLose, 0);
    expect(gain).toBeCloseTo(f.standToGain, 9);
    expect(lose).toBeCloseTo(f.standToLose, 9);
  });
});

describe("estimated marks as evidence", () => {
  const mark = (id: string, ratio: number, status: GradeStatus = "RETURNED"): GradeEntry => ({
    id,
    name: id,
    points: ratio * 100,
    max: 100,
    status,
    sortOrder: 0,
  });
  const pending = (id: string): GradeEntry => ({
    id,
    name: id,
    points: null,
    max: 100,
    status: "PENDING",
    sortOrder: 9,
  });

  const category = (id: string, entries: GradeEntry[], over: Partial<GradeCategory> = {}): GradeCategory => ({
    id,
    name: id,
    weightMode: "FIXED",
    weight: 1,
    weightByMax: true,
    forecastBasis: "CATEGORY",
    sortOrder: 0,
    entries,
    ...over,
  });

  const band = (categories: GradeCategory[], config = DEFAULT_GRADE_CONFIG, index = 0) =>
    forecast(categories, summarize(categories, config), config).categories[index]!;

  it("excludes guesses by default, so they cannot narrow their own forecast", () => {
    const returned = [mark("a", 0.8), mark("b", 0.9), mark("c", 0.85), pending("next")];
    const withGuesses = [
      ...returned,
      mark("g1", 1, "ESTIMATED"),
      mark("g2", 1, "ESTIMATED"),
      mark("g3", 1, "ESTIMATED"),
    ];
    // Nothing about the forecast moves: same spread, same effective size, and
    // now the same band too. The prior anchors on the mean of what was actually
    // inferred from, so a guess kept out of the sample is kept out entirely --
    // it can no longer shift the band by dragging the grade around.
    const before = band([category("c", returned)]);
    const after = band([category("c", withGuesses)]);
    expect(after.sd).toBeCloseTo(before.sd, 12);
    expect(after.effectiveSampleSize).toBeCloseTo(before.effectiveSampleSize, 12);
    expect(after.band).toBeCloseTo(before.band, 12);
    expect(after.expected).toEqual(before.expected);
  });

  it("counts them in full at estimateWeight 1, which is the old behaviour", () => {
    const entries = [mark("a", 0.8), mark("b", 0.9), mark("g", 1, "ESTIMATED"), pending("next")];
    const included = { ...DEFAULT_GRADE_CONFIG, estimateWeight: 1 };
    const asReturned = [mark("a", 0.8), mark("b", 0.9), mark("g", 1), pending("next")];
    expect(band([category("c", entries)], included).band).toBeCloseTo(
      band([category("c", asReturned)], included).band,
      12,
    );
  });

  it("sits between the two at partial credit", () => {
    const entries = [mark("a", 0.7), mark("b", 0.95), mark("g", 1, "ESTIMATED"), pending("next")];
    const at = (estimateWeight: number) =>
      band([category("c", entries)], { ...DEFAULT_GRADE_CONFIG, estimateWeight });

    // Effective sample size is the quantity partial credit is really about,
    // and it rises strictly with the weight given to the guess.
    const sizes = [0, 0.25, 0.5, 0.75, 1].map((w) => at(w).effectiveSampleSize);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
    expect(sizes[0]).toBeCloseTo(2, 12); // the guess contributes nothing
    expect(sizes[sizes.length - 1]).toBeCloseTo(3, 12); // ...and then everything

    // NOT the band, which is not monotone in the weight. Degrees of freedom are
    // truncated to whole numbers (`truncateDegreesOfFreedom`, kept for parity
    // with the spreadsheet), so the t multiplier steps rather than slides and
    // the width can tick the "wrong" way between steps. Real, inherited, and
    // small -- but it means the band is the wrong thing to assert on here.
    expect(at(0).sd).toBeGreaterThan(at(1).sd);
  });

  it("never touches the grade itself, at any weight", () => {
    // The whole point of the setting is that it is confined to the forecast.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ratio: fc.oneof(
      // The domain is [0, +inf): a score is points over points possible, and
      // nothing stops a category awarding more than it asks for. The upper
      // bound here is not a rule the engine knows -- every invariant below is
      // scale-free and holds identically at 5000% -- it exists only because
      // fast-check needs a finite range to sample. Weighted so the ordinary
      // 0-100% case still gets most of the draws while extra credit, the case
      // that hid the clamp bug, shows up often enough to matter.
      { arbitrary: fc.double({ min: 0, max: 1.2, noNaN: true }), weight: 4 },
      { arbitrary: fc.double({ min: 1, max: 50, noNaN: true }), weight: 1 },
    ),
            status: fc.constantFrom<GradeStatus>("RETURNED", "ESTIMATED", "PENDING", "POSSIBLE"),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (rows, estimateWeight) => {
          const entries = rows.map((r, i) => ({
            id: `e${i}`,
            name: `Entry ${i}`,
            points: r.status === "PENDING" ? null : r.ratio * 100,
            max: 100,
            status: r.status,
            sortOrder: i,
          }));
          const sheet = [category("c", entries)];
          const base = summarize(sheet);
          const moved = summarize(sheet, { ...DEFAULT_GRADE_CONFIG, estimateWeight });
          expect(moved.percent).toBe(base.percent);
          expect(moved.impact).toBe(base.impact);
          expect(moved.categories[0]!.weight).toBe(base.categories[0]!.weight);
        },
      ),
    );
  });

  it("treats an all-guesses category as knowing nothing about itself", () => {
    const guesses = [mark("g1", 1, "ESTIMATED"), mark("g2", 1, "ESTIMATED"), pending("next")];
    // On its own, with guesses discounted, it has no sample: the whole scale.
    expect(band([category("c", guesses)]).expected).toEqual({ low: 0, high: 1 });

    // Told to borrow when it has nothing, it borrows -- which only works
    // because the sparse test counts EVIDENCE rather than rows.
    const borrowing = [
      category("guesses", guesses, { forecastBasis: "COURSE_WHEN_SPARSE", weight: 0.5 }),
      category("real", [mark("a", 0.8), mark("b", 0.9), mark("c", 0.85)], { weight: 0.5 }),
    ];
    const borrowed = band(borrowing, DEFAULT_GRADE_CONFIG, 0);
    expect(borrowed.expected.low).toBeGreaterThan(0);
    expect(borrowed.expected.high).toBeLessThanOrEqual(1);
  });

  it("attaches the weight to the ROW, not to whoever is reading it", () => {
    // Two sources of guesses: one category counts its own, the other does not.
    // A third reads the whole course.
    const sheet = (readerWeight: number | null): GradeCategory[] => [
      category("trusting", [mark("t1", 0.6, "ESTIMATED"), mark("t2", 0.62, "ESTIMATED")], {
        weight: 0.3,
        estimateWeight: 1,
      }),
      category("doubting", [mark("d1", 0.99, "ESTIMATED"), mark("d2", 0.98, "ESTIMATED")], {
        weight: 0.3,
        estimateWeight: 0,
      }),
      category("reader", [mark("r1", 0.8), pending("next")], {
        weight: 0.4,
        forecastBasis: "COURSE",
        estimateWeight: readerWeight,
      }),
    ];

    // The reader's OWN setting governs only its own rows, so flipping it
    // changes nothing about the pool it is reading.
    const asDefault = band(sheet(null), DEFAULT_GRADE_CONFIG, 2);
    const asTrusting = band(sheet(1), DEFAULT_GRADE_CONFIG, 2);
    expect(asTrusting.band).toBeCloseTo(asDefault.band, 12);

    // And the pool really did contain the trusting category's guesses: drop
    // them and the reader's band moves.
    const withoutTrusted = sheet(null).map((c) =>
      c.id === "trusting" ? { ...c, estimateWeight: 0 } : c,
    );
    expect(band(withoutTrusted, DEFAULT_GRADE_CONFIG, 2).band).not.toBeCloseTo(asDefault.band, 6);
  });
});

describe("the 100% ceiling is optional, because extra credit is real", () => {
  const mark = (i: number, pts: number): GradeEntry => ({
    id: `e${i}`, name: `Set ${i}`, points: pts, max: 100, status: "RETURNED", sortOrder: i,
  });
  const sheet = (capForecast: boolean | null): GradeCategory[] => [
    {
      id: "hw",
      name: "Homework",
      weightMode: "FIXED",
      weight: 1,
      weightByMax: true,
      forecastBasis: "CATEGORY",
      capForecast,
      sortOrder: 0,
      entries: [
        mark(1, 110), mark(2, 111), mark(3, 109), mark(4, 110), mark(5, 110),
        { id: "p", name: "Next", points: null, max: 100, status: "PENDING", sortOrder: 9 },
      ],
    },
  ];
  const at = (capForecast: boolean | null) => {
    const cats = sheet(capForecast);
    return forecast(cats, summarize(cats)).categories[0]!;
  };

  it("infers on capped marks, so a 110% category is centred on 100%", () => {
    // Every mark clamps to 100, so the sample has no spread of its own and the
    // whole band is the prior's. NOT a point estimate: truncating the interval
    // after inference used to give [100%, 100%], reintroducing exactly the
    // certainty the prior exists to prevent, somewhere no prior could reach.
    const capped = at(true);
    expect(capped.sd).toBeCloseTo(0, 12);
    expect(capped.expected.high).toBe(1);
    expect(capped.expected.low).toBeCloseTo(1 - capped.band, 9);
    expect(capped.expected.low).toBeLessThan(capped.expected.high);
    expect(capped.result!.low).toBeLessThanOrEqual(capped.result!.high);
  });

  it("keeps the grade on the raw marks even while forecasting on capped ones", () => {
    const s = summarize(sheet(true));
    expect(s.categories[0]!.percent).toBeCloseTo(1.1, 12);
    expect(s.percent).toBeCloseTo(1.1, 12);
  });

  it("leaves what actually happened alone", () => {
    // The clamp is on the FORECAST. The category really did average 110%, and
    // every column describing the present goes on saying so.
    const cats = sheet(true);
    const s = summarize(cats);
    expect(s.categories[0]!.percent).toBeCloseTo(1.1, 12);
    expect(s.percent).toBeCloseTo(1.1, 12);
    expect(s.categories[0]!.impact).toBeCloseTo(0.1, 12);
  });

  it("softens rather than removes the ceiling when extra credit is enabled", () => {
    const free = at(false);
    // Anchored midway between the best mark (111%) and the second best (110%),
    // not at the mean and not at infinity: past the anchor the band grows at
    // half rate.
    const anchor = (1.11 + 1.1) / 2;
    const raw = 1.1 + free.band;
    expect(free.expected.high).toBeCloseTo(anchor + (raw - anchor) * 0.5, 9);
    expect(free.expected.high).toBeGreaterThan(anchor);
    expect(free.expected.high).toBeLessThan(raw);
  });

  it("does not let one outlier carry the anchor on its own", () => {
    // The case a maximum-anchored ceiling could not touch: 132% among four
    // 100s put the kink at 132%, beyond the band's own reach, so nothing was
    // damped. The midpoint puts it at 116% and the damping engages.
    const outlier: GradeCategory[] = [
      {
        id: "o", name: "Outlier", weightMode: "FIXED", weight: 1, weightByMax: true,
        forecastBasis: "CATEGORY", capForecast: false, sortOrder: 0,
        entries: [
          mark(1, 100), mark(2, 100), mark(3, 132), mark(4, 100), mark(5, 100),
          { id: "p", name: "Next", points: null, max: 100, status: "PENDING", sortOrder: 9 },
        ],
      },
    ];
    const s = summarize(outlier);
    const f = forecast(outlier, s).categories[0]!;
    const anchor = (1.32 + 1.0) / 2;
    const raw = s.categories[0]!.percent! + f.band;
    expect(raw).toBeGreaterThan(anchor); // the kink is now inside the band
    expect(f.expected.high).toBeCloseTo(anchor + (raw - anchor) * 0.5, 9);
    expect(f.expected.high).toBeLessThan(raw);
  });

  it("treats tied best marks as genuinely reachable", () => {
    // Two marks at 107% is evidence 107% is reachable, so the midpoint of the
    // top two IS 107% and nothing below it is damped.
    const tied: GradeCategory[] = [
      {
        id: "t", name: "Tied", weightMode: "FIXED", weight: 1, weightByMax: true,
        forecastBasis: "CATEGORY", capForecast: false, sortOrder: 0,
        entries: [
          mark(1, 107), mark(2, 107), mark(3, 103), mark(4, 105),
          { id: "p", name: "Next", points: null, max: 100, status: "PENDING", sortOrder: 9 },
        ],
      },
    ];
    const s = summarize(tied);
    const f = forecast(tied, s).categories[0]!;
    const raw = s.categories[0]!.percent! + f.band;
    expect(f.expected.high).toBeCloseTo(1.07 + (raw - 1.07) * 0.5, 9);
  });

  it("lets a lone observation anchor itself, there being no gap to split", () => {
    const single: GradeCategory[] = [
      {
        id: "s", name: "Single", weightMode: "FIXED", weight: 1, weightByMax: true,
        forecastBasis: "CATEGORY", capForecast: false, sortOrder: 0,
        entries: [
          mark(1, 108),
          { id: "p", name: "Next", points: null, max: 100, status: "PENDING", sortOrder: 9 },
        ],
      },
    ];
    const f = forecast(single, summarize(single)).categories[0]!;
    const raw = 1.08 + f.band;
    expect(f.expected.high).toBeCloseTo(1.08 + (raw - 1.08) * 0.5, 9);
  });

  it("does not penalise the ordinary range when extra credit is enabled", () => {
    // A category whose best mark is 95% still gets an unpenalised run up to
    // 100%: the anchor is max(100%, best seen), so nothing below 100 is damped.
    const mild: GradeCategory[] = [
      {
        id: "m", name: "Mild", weightMode: "FIXED", weight: 1, weightByMax: true,
        forecastBasis: "CATEGORY", capForecast: false, sortOrder: 0,
        entries: [
          mark(1, 92), mark(2, 95), mark(3, 93),
          { id: "p", name: "Next", points: null, max: 100, status: "PENDING", sortOrder: 9 },
        ],
      },
    ];
    const f = forecast(mild, summarize(mild)).categories[0]!;
    const raw = 0.9333333333333333 + f.band;
    if (raw <= 1) expect(f.expected.high).toBeCloseTo(raw, 9);
    else expect(f.expected.high).toBeCloseTo(1 + (raw - 1) * 0.5, 9);
  });

  it("still spans 0-100 for a category with nothing to go on", () => {
    const empty: GradeCategory[] = [
      {
        id: "e", name: "Final", weightMode: "FIXED", weight: 1, weightByMax: true,
        forecastBasis: "CATEGORY", capForecast: false, sortOrder: 0,
        entries: [{ id: "f", name: "Exam", points: null, max: 100, status: "PENDING", sortOrder: 0 }],
      },
    ];
    // Extra credit is a claim about how a category marks; an empty one has made
    // no such claim, so turning the cap off buys it nothing.
    expect(forecast(empty, summarize(empty)).categories[0]!.expected).toEqual({ low: 0, high: 1 });
  });
});
