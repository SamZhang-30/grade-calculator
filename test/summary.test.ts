import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_GRADE_CONFIG,
  summarize,
  type GradeCategory,
  type GradeEntry,
  type GradeStatus,
} from "../src/grade-engine/index.js";

/**
 * Properties over the invariants the sheet is supposed to have, rather than
 * assertions about particular numbers. The two reference tests pin the engine
 * to the real spreadsheet; these pin the SHAPE of it, so a formula change that
 * still happens to reproduce one course is caught anyway.
 */

const statusArb = fc.constantFrom<GradeStatus>("RETURNED", "ESTIMATED", "PENDING", "POSSIBLE");

/** Realistic magnitudes: scores land near their max, so impacts stay small. */
const rawEntryArb = fc
  .record({
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
    status: statusArb,
  })
  .map(({ max, ratio, scored, status }) => ({
    max,
    points: scored ? ratio * max : null,
    status,
  }));

const rawCategoryArb = fc.record({
  // Weights as a syllabus states them -- whole percentage points, not denormals.
  weight: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
  weightByMax: fc.boolean(),
  entries: fc.array(rawEntryArb, { minLength: 0, maxLength: 8 }),
});

/** Ids are assigned positionally, so every row in a generated sheet is unique. */
const sheetArb = fc.array(rawCategoryArb, { minLength: 1, maxLength: 5 }).map((cats) =>
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
          points: e.points,
          max: e.max,
          status: e.status,
          sortOrder: j,
        }),
      ),
    }),
  ),
);

describe("telescoping", () => {
  it("row impacts sum to their category's, category impacts sum to the course's", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        const result = summarize(sheet);
        for (const category of result.categories) {
          const fromRows = category.entries.reduce((sum, e) => sum + e.impact, 0);
          expect(category.impact).toBeCloseTo(fromRows, 9);
        }
        const fromCategories = result.categories.reduce((sum, c) => sum + c.impact, 0);
        expect(result.impact).toBeCloseTo(fromCategories, 9);
        if (result.percent !== null) expect(result.percent).toBeCloseTo(1 + result.impact, 9);
      }),
    );
  });

  it("a category's impact equals (percent - 1) x weight, however it was weighted", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        for (const category of summarize(sheet).categories) {
          if (category.percent === null) continue;
          expect(category.impact).toBeCloseTo((category.percent - 1) * category.weight, 9);
        }
      }),
    );
  });
});

describe("weights", () => {
  it("always account for exactly 100% once anything is graded", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        const result = summarize(sheet);
        if (result.percent === null) return;
        const total = result.categories.reduce((sum, c) => sum + c.weight, 0);
        expect(total).toBeCloseTo(1, 9);
      }),
    );
  });

  it("never let a row weigh anything until it is scored", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        for (const category of summarize(sheet).categories) {
          for (const entry of category.entries) {
            if (!entry.counted) expect(entry.weight).toBe(0);
          }
        }
      }),
    );
  });

  it("keeps represented final weight as the exact complement of at stake", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        const result = summarize(sheet);
        if (result.percent === null) return;
        const represented = result.categories.reduce((sum, category) => sum + category.finalWeight, 0);
        expect(represented).toBeCloseTo(1 - result.atStakePercent, 9);
      }),
    );
  });
});

describe("final-assignment current weighting", () => {
  const course = (): GradeCategory[] => [
    {
      id: "homework",
      name: "Homework",
      weightMode: "FIXED",
      weight: 0.6,
      weightByMax: true,
      sortOrder: 0,
      entries: [
        { id: "h1", name: "Homework", points: 90, max: 100, status: "RETURNED", sortOrder: 0 },
      ],
    },
    {
      id: "midterms",
      name: "Midterms",
      weightMode: "FIXED",
      weight: 0.4,
      weightByMax: true,
      sortOrder: 1,
      entries: [
        { id: "m1", name: "Midterm 1", points: 80, max: 100, status: "RETURNED", sortOrder: 0 },
        { id: "m2", name: "Midterm 2", points: null, max: 100, status: "PENDING", sortOrder: 1 },
      ],
    },
  ];

  it("prices pending work first, then normalizes only the scored final weights", () => {
    const result = summarize(course());
    const [homework, midterms] = result.categories;

    expect(DEFAULT_GRADE_CONFIG.currentGradeWeighting).toBe("FINAL_ASSIGNMENT");
    expect(homework!.finalWeight).toBeCloseTo(0.6, 12);
    expect(midterms!.entries[0]!.finalWeight).toBeCloseTo(0.2, 12);
    expect(midterms!.entries[1]!.finalWeight).toBeCloseTo(0.2, 12);
    expect(midterms!.atStakePercent).toBeCloseTo(0.2, 12);
    expect(homework!.weight).toBeCloseTo(0.75, 12);
    expect(midterms!.weight).toBeCloseTo(0.25, 12);
    expect(result.percent).toBeCloseTo(0.875, 12);
    expect(result.warnings).toEqual([]);
  });

  it("retains category-progress weighting as an explicit legacy option", () => {
    const result = summarize(course(), {
      ...DEFAULT_GRADE_CONFIG,
      currentGradeWeighting: "CATEGORY_PROGRESS",
    });
    expect(result.categories[0]!.weight).toBeCloseTo(0.6, 12);
    expect(result.categories[1]!.weight).toBeCloseTo(0.4, 12);
    expect(result.percent).toBeCloseTo(0.86, 12);
  });
});

describe("POSSIBLE rows are inert", () => {
  it("adding hypotheticals moves no number at all", () => {
    fc.assert(
      fc.property(sheetArb, fc.array(rawEntryArb, { maxLength: 4 }), (sheet, extras) => {
        const before = summarize(sheet);
        const after = summarize(
          sheet.map((c, i) =>
            i !== 0
              ? c
              : {
                  ...c,
                  entries: [
                    ...c.entries,
                    ...extras.map(
                      (e, j): GradeEntry => ({
                        id: `hypothetical${j}`,
                        name: `What if ${j}`,
                        points: e.points,
                        max: e.max,
                        status: "POSSIBLE",
                        sortOrder: 1000 + j,
                      }),
                    ),
                  ],
                },
          ),
        );
        expect(after.percent).toBe(before.percent);
        expect(after.impact).toBe(before.impact);
        expect(after.atStakePercent).toBe(before.atStakePercent);
        after.categories.forEach((c, i) => {
          expect(c.weight).toBe(before.categories[i]!.weight);
          expect(c.atStakePoints).toBe(before.categories[i]!.atStakePoints);
        });
      }),
    );
  });
});

describe("scoring at your own average changes nothing", () => {
  it("a pending row returned at the category percentage leaves the grade where it was", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        const legacy = {
          ...DEFAULT_GRADE_CONFIG,
          currentGradeWeighting: "CATEGORY_PROGRESS" as const,
        };
        const before = summarize(sheet, legacy);
        const target = before.categories.findIndex(
          (c, i) => c.percent !== null && sheet[i]!.entries.some((e) => e.status === "PENDING"),
        );
        if (target < 0 || before.percent === null) return;

        const percent = before.categories[target]!.percent!;
        let flipped = false;
        const after = summarize(
          sheet.map((c, i) =>
            i !== target
              ? c
              : {
                  ...c,
                  entries: c.entries.map((e) => {
                    if (flipped || e.status !== "PENDING") return e;
                    flipped = true;
                    return { ...e, status: "RETURNED" as const, points: percent * (e.max ?? 0) };
                  }),
                },
          ),
          legacy,
        );
        expect(after.percent).toBeCloseTo(before.percent, 9);
      }),
    );
  });
});

describe("splitting an assignment", () => {
  it("is invisible when weight follows point value", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        const byMax = sheet.map((c) => ({ ...c, weightByMax: true }));
        const before = summarize(byMax);
        if (before.percent === null) return;

        // Halve the first scored row of the first category into two rows.
        const first = byMax[0]!;
        const victim = first.entries.find((e) => e.points !== null && e.status === "RETURNED");
        if (!victim) return;

        const after = summarize([
          {
            ...first,
            entries: first.entries.flatMap((e) =>
              e.id !== victim.id
                ? [e]
                : [
                    { ...e, id: `${e.id}a`, points: e.points! / 2, max: e.max! / 2 },
                    { ...e, id: `${e.id}b`, points: e.points! / 2, max: e.max! / 2 },
                  ],
            ),
          },
          ...byMax.slice(1),
        ]);
        expect(after.percent).toBeCloseTo(before.percent, 9);
      }),
    );
  });

  it("is NOT invisible under flat weighting -- which is the whole difference", () => {
    // Two assignments, 100% and 50%, equally weighted: the category is at 75%.
    const flat = (entries: GradeEntry[]): GradeCategory[] => [
      {
        id: "c",
        name: "Category",
        weightMode: "FIXED",
        weight: 1,
        weightByMax: false,
        sortOrder: 0,
        entries,
      },
    ];
    const row = (id: string, points: number, max: number): GradeEntry => ({
      id,
      name: id,
      points,
      max,
      status: "RETURNED",
      sortOrder: 0,
    });

    expect(summarize(flat([row("a", 100, 100), row("b", 50, 100)])).percent).toBeCloseTo(0.75, 12);
    // Splitting the weaker one into two halves gives it two votes instead of one.
    expect(
      summarize(flat([row("a", 100, 100), row("b1", 25, 50), row("b2", 25, 50)])).percent,
    ).toBeCloseTo(2 / 3, 12);
  });
});

describe("pooling", () => {
  it("n pooled categories equal one fixed category holding the same rows", () => {
    fc.assert(
      fc.property(sheetArb, (sheet) => {
        const pooled = sheet.map((c): GradeCategory => ({ ...c, weightMode: "POOLED", weight: 0 }));
        const single: GradeCategory[] = [
          {
            id: "single",
            name: "Everything",
            weightMode: "FIXED",
            weight: 1,
            weightByMax: true,
            sortOrder: 0,
            entries: sheet.flatMap((c) => c.entries),
          },
        ];
        const a = summarize(pooled);
        const b = summarize(single);
        if (b.percent === null) {
          expect(a.percent).toBeNull();
          return;
        }
        expect(a.percent).toBeCloseTo(b.percent, 9);
        expect(a.atStakePercent).toBeCloseTo(b.atStakePercent, 9);
      }),
    );
  });
});

describe("order independence", () => {
  it("shuffling categories and rows gives the same course grade", () => {
    fc.assert(
      fc.property(sheetArb, fc.integer({ min: 1, max: 50 }), (sheet, shift) => {
        const before = summarize(sheet);
        const rotated = [...sheet]
          .reverse()
          .map((c) => ({ ...c, entries: [...c.entries].reverse() }));
        const after = summarize(rotated);
        expect(after.percent === null ? null : after.percent).toEqual(
          before.percent === null ? null : before.percent,
        );
        expect(after.impact).toBeCloseTo(before.impact, 12);
        void shift;
      }),
    );
  });
});

describe("an empty gradebook", () => {
  it("raises no warnings at all", () => {
    // Nothing has been set up, so there is nothing yet to be wrong.
    expect(summarize([])).toEqual({
      categories: [],
      pooledResidual: 0,
      percent: null,
      impact: 0,
      atStakePercent: 0,
      warnings: [],
    });
  });

  it("says nothing about weights until something is graded", () => {
    // Weights that do not add up are worth mentioning only once they are
    // distorting a number on screen. With nothing marked there is no
    // percentage yet, so there is nothing to caveat.
    const result = summarize([
      {
        id: "c",
        name: "Homework",
        weightMode: "FIXED",
        weight: 0.2,
        weightByMax: true,
        sortOrder: 0,
        entries: [],
      },
    ]);
    expect(result.percent).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("raises ONE warning, not two, when graded weight falls short", () => {
    const result = summarize(
      [
        {
          id: "c",
          name: "Homework",
          weightMode: "FIXED",
          weight: 0.2,
          weightByMax: true,
          sortOrder: 0,
          entries: [{ id: "a", name: "Set 1", points: 9, max: 10, status: "RETURNED", sortOrder: 0 }],
        },
      ],
      { ...DEFAULT_GRADE_CONFIG, currentGradeWeighting: "CATEGORY_PROGRESS" },
    );
    expect(result.warnings.map((w) => w.code)).toEqual(["RENORMALIZED"]);
    // 20% of a syllabus, stretched to be the whole of the current grade.
    expect(result.percent).toBeCloseTo(0.9, 12);
    expect(result.categories[0]!.weight).toBeCloseTo(1, 12);
  });
});

describe("a row with no points possible", () => {
  const row = (over: Partial<GradeEntry>): GradeEntry => ({
    id: "half",
    name: "Half-entered",
    points: null,
    max: null,
    status: "PENDING",
    sortOrder: 1,
    ...over,
  });
  const sheet = (extra: GradeEntry): GradeCategory[] => [
    {
      id: "c",
      name: "Homework",
      weightMode: "FIXED",
      weight: 1,
      weightByMax: true,
      sortOrder: 0,
      entries: [
        { id: "a", name: "Set 1", points: 8, max: 10, status: "RETURNED", sortOrder: 0 },
        extra,
      ],
    },
  ];

  it("is inert whatever its status claims", () => {
    // No denominator means no percentage, no weight, and nothing at stake --
    // there is simply nothing to divide by yet.
    for (const status of ["RETURNED", "ESTIMATED", "PENDING", "POSSIBLE"] as const) {
      const result = summarize(sheet(row({ status, points: status === "PENDING" ? null : 5 })));
      expect(result.percent).toBeCloseTo(0.8, 12);
      expect(result.categories[0]!.atStakePoints).toBe(0);
      expect(result.categories[0]!.entries[1]!.weight).toBe(0);
      expect(result.categories[0]!.entries[1]!.counted).toBe(false);
      expect(result.warnings).toEqual([]);
    }
  });

  it("joins in the moment a max arrives", () => {
    const result = summarize(sheet(row({ status: "PENDING", max: 10 })));
    expect(result.categories[0]!.atStakePoints).toBe(10);
    expect(result.categories[0]!.atStakePercent).toBeCloseTo(0.5, 12);
  });

  it("still flags a max that was entered as zero", () => {
    const result = summarize(sheet(row({ max: 0 })));
    expect(result.warnings.map((w) => w.code)).toEqual(["INVALID_MAX"]);
  });
});

describe("a category holding nothing but pending work", () => {
  // The case a new unit looks like: the syllabus says the final is worth 40%,
  // the exam is on the calendar, and no mark exists yet.
  const sheet = (): GradeCategory[] => [
    {
      id: "homework",
      name: "Homework",
      weightMode: "FIXED",
      weight: 0.6,
      weightByMax: true,
      sortOrder: 0,
      entries: [{ id: "h1", name: "Set 1", points: 45, max: 50, status: "RETURNED", sortOrder: 0 }],
    },
    {
      id: "final",
      name: "Final",
      weightMode: "FIXED",
      weight: 0.4,
      weightByMax: true,
      sortOrder: 1,
      entries: [{ id: "f1", name: "Final exam", points: null, max: 200, status: "PENDING", sortOrder: 0 }],
    },
  ];

  const result = summarize(sheet());
  const [homework, final] = result.categories;

  it("carries NO weight in the current grade", () => {
    // Nothing is marked, so it cannot pull the average anywhere. Homework is
    // renormalized to the whole of it.
    expect(final!.weight).toBe(0);
    expect(final!.percent).toBeNull();
    expect(final!.impact).toBe(0);
    expect(homework!.weight).toBeCloseTo(1, 12);
    expect(result.percent).toBeCloseTo(0.9, 12);
  });

  it("carries its FULL weight in the at-stake column", () => {
    // The at-stake denominator counts categories with ANY rows, so the final
    // keeps the 40% it is going to be worth. This is the whole reason the two
    // columns are normalized separately.
    expect(final!.syllabusWeight).toBeCloseTo(0.4, 12);
    expect(final!.atStakePoints).toBe(200);
    expect(final!.atStakePercent).toBeCloseTo(0.4, 12);
    expect(result.atStakePercent).toBeCloseTo(0.4, 12);
  });

  it("takes its weight back the moment a mark lands", () => {
    const marked = sheet();
    marked[1]!.entries[0] = { ...marked[1]!.entries[0]!, points: 150, status: "RETURNED" };
    const after = summarize(marked);
    expect(after.categories[1]!.weight).toBeCloseTo(0.4, 12);
    expect(after.categories[0]!.weight).toBeCloseTo(0.6, 12);
    // 0.6 x 90% + 0.4 x 75% = 84%.
    expect(after.percent).toBeCloseTo(0.84, 12);
    expect(after.atStakePercent).toBe(0);
    expect(after.warnings).toEqual([]);
  });

  it("is inert in BOTH columns while it still has no denominator", () => {
    const noMax = sheet();
    noMax[1]!.entries[0] = { ...noMax[1]!.entries[0]!, max: null };
    const after = summarize(noMax);
    expect(after.categories[1]!.syllabusWeight).toBe(0);
    expect(after.atStakePercent).toBe(0);
  });
});

describe("at stake is measured in the unit the category is weighed in", () => {
  const sheet = (weightByMax: boolean): GradeCategory[] => [
    {
      id: "c",
      name: "Participation",
      weightMode: "FIXED",
      weight: 1,
      weightByMax,
      sortOrder: 0,
      entries: [
        { id: "a", name: "Day 1", points: 10, max: 10, status: "RETURNED", sortOrder: 0 },
        { id: "b", name: "Day 2", points: null, max: 10, status: "PENDING", sortOrder: 1 },
        { id: "c", name: "Day 3", points: null, max: 30, status: "PENDING", sortOrder: 2 },
        { id: "d", name: "Day 4", points: null, max: null, status: "PENDING", sortOrder: 3 },
      ],
    },
  ];

  it("reports both a point total and a row count", () => {
    const byPoints = summarize(sheet(true)).categories[0]!;
    // The row with no max is not at stake in either unit -- it cannot be.
    expect(byPoints.atStakePoints).toBe(40);
    expect(byPoints.atStakeCount).toBe(2);
  });

  it("keeps the count identical however the category is weighed", () => {
    // The percentage differs between the two modes; the tally of what is left
    // does not, because it is a fact about the rows rather than the weighting.
    expect(summarize(sheet(false)).categories[0]!.atStakeCount).toBe(2);
    expect(summarize(sheet(false)).categories[0]!.atStakePoints).toBe(40);
    expect(summarize(sheet(false)).categories[0]!.atStakePercent).toBeCloseTo(2 / 3, 12);
    expect(summarize(sheet(true)).categories[0]!.atStakePercent).toBeCloseTo(40 / 50, 12);
  });
});
