/**
 * The shapes a course grade sheet is made of.
 *
 * Both the server and the client import these -- SQLite has no enums, so
 * `status` and `weightMode` are stored as strings and narrowed to these unions
 * at the route boundary, exactly the way `Currency` works in the XP engine.
 */

/**
 * How much a row is known, and therefore what it is allowed to affect.
 *
 * The four states exist because a syllabus is entered LONG before it is graded,
 * and a half-entered sheet has to stay correct the whole way. Only `RETURNED`
 * and `ESTIMATED` move your current grade; `PENDING` is the future you can still
 * change; `POSSIBLE` is a thought experiment that must never leak into a number.
 */
export type GradeStatus =
  /** Marked and handed back. The score is fact. */
  | "RETURNED"
  /** A considered guess -- participation, a rubric you can predict. Counts
   *  toward the current total, but is deliberately excluded from the sample any
   *  forecast is built from, so guessing cannot narrow a confidence interval. */
  | "ESTIMATED"
  /** Assigned but unscored -- rendered `*`. Counts toward AT STAKE only. */
  | "PENDING"
  /** Hypothetical -- rendered `^`. Counts toward NOTHING, anywhere. */
  | "POSSIBLE";

export const GRADE_STATUSES: readonly GradeStatus[] = [
  "RETURNED",
  "ESTIMATED",
  "PENDING",
  "POSSIBLE",
] as const;

/**
 * Where a category's share of the final grade comes from.
 *
 * - `FIXED`  -- the syllabus states it ("the final is 30%").
 * - `POOLED` -- total-points marking: the category has no weight of its own, and
 *               instead draws from whatever the fixed categories left over, in
 *               proportion to its points.
 *
 * The two mix, which is the point. "Final exam 50%, everything else out of a
 * shared 50%" is one FIXED category and n POOLED ones, not a special case.
 */
export type WeightMode = "FIXED" | "POOLED";

export const WEIGHT_MODES: readonly WeightMode[] = ["FIXED", "POOLED"] as const;

/**
 * How final assignment weights are turned into the current course grade.
 *
 * `FINAL_ASSIGNMENT` prices every returned and pending assignment against the
 * full entered roster first, then renormalizes only the returned weights. This
 * keeps one of two equally weighted midterms at half of their category's final
 * share while the other is pending.
 *
 * `CATEGORY_PROGRESS` is the original behavior: each category redistributes
 * its full share over whichever assignments have already been scored.
 */
export type CurrentGradeWeighting = "FINAL_ASSIGNMENT" | "CATEGORY_PROGRESS";

export const CURRENT_GRADE_WEIGHTINGS: readonly CurrentGradeWeighting[] = [
  "FINAL_ASSIGNMENT",
  "CATEGORY_PROGRESS",
] as const;

/** How a category-level percentage is transformed after its raw score is known. */
export type CurveMode = "ADDITIVE" | "MULTIPLICATIVE" | "CUSTOM";

export const CURVE_MODES: readonly CurveMode[] = [
  "ADDITIVE",
  "MULTIPLICATIVE",
  "CUSTOM",
] as const;

/**
 * Which observations a category's forecast is built from.
 *
 * A category with three marks knows almost nothing about itself; the course
 * around it may know a great deal. This is the dial between the two.
 */
export type ForecastBasis =
  /** Always the whole course. Steady, but blind to a category being harder. */
  | "COURSE"
  /** The category's own marks once it has any, the course until then. */
  | "COURSE_WHEN_SPARSE"
  /** Only this category, however little it has. */
  | "CATEGORY";

export const FORECAST_BASES: readonly ForecastBasis[] = [
  "COURSE",
  "COURSE_WHEN_SPARSE",
  "CATEGORY",
] as const;

export interface GradeEntry {
  id: string;
  name: string;
  /** null until a score is known. */
  points: number | null;
  /**
   * Points possible -- the DENOMINATOR, and the thing that decides whether a
   * row can participate at all.
   *
   * null until you know it. A row with no max is inert everywhere regardless of
   * status: it cannot be a percentage, it cannot be weighed against its
   * siblings, and it cannot be at stake, because none of those are defined
   * without something to divide by. It still shows in the table, waiting.
   */
  max: number | null;
  status: GradeStatus;
  sortOrder: number;
}

export interface GradeCategory {
  id: string;
  name: string;
  weightMode: WeightMode;
  /** Share of the final grade as a fraction, 0-1. Ignored when POOLED. */
  weight: number;
  /**
   * Whether `max` sets relative weight WITHIN the category.
   *
   * true  -- a 60-point lab counts twice a 30-point one (points-proportional).
   * false -- every assignment in the category weighs the same regardless of size.
   *
   * Forced true for POOLED categories: points-proportional is what "total
   * points" means, so the toggle would be self-contradicting there.
   */
  weightByMax: boolean;
  /**
   * Significance level for THIS category's forecast band, overriding the
   * config default. null inherits it.
   */
  alphaOverride?: number | null;
  /** Which sample the forecast draws on. null inherits the config default. */
  forecastBasis?: ForecastBasis | null;
  /**
   * How much THIS category's estimated marks are worth as evidence, overriding
   * the config default. null inherits.
   *
   * A property of the rows, not of the reader: it applies wherever this
   * category's estimates are used, including when another category borrows
   * them through the course-wide pool. Participation guesses may be
   * near-certain while essay guesses are wild, and that is a fact about the
   * marks rather than about whoever is consulting them.
   */
  estimateWeight?: number | null;
  /**
   * Whether THIS category's forecast is held to 100%. null inherits.
   *
   * Per category because extra credit is a property of how one kind of work is
   * marked, not of the course.
   */
  capForecast?: boolean | null;
  /** Curves operate on the category percentage, expressed on a 0–100 scale. */
  curveEnabled?: boolean;
  curveMode?: CurveMode;
  /** Percentage points added in ADDITIVE mode. */
  curveAddend?: number;
  /** Percentage multiplier in MULTIPLICATIVE mode: 110 means x 1.10. */
  curveMultiplier?: number;
  /** CUSTOM expression using `x` as the raw percentage from 0–100. */
  curveExpression?: string;
  /** Whether only the upper end of the curved score is held to 100%. */
  curveCap?: boolean;
  sortOrder: number;
  entries: GradeEntry[];
}

/** Something the sheet cannot resolve on its own, surfaced rather than guessed. */
export interface GradeWarning {
  code:
    /** Fixed weights already exceed 100%, so the pool's residual is empty. */
    | "FIXED_EXCEEDS_100"
    /**
     * The categories with graded work do not total 100% of the final grade, so
     * the percentage shown has been renormalized over the part that is graded.
     *
     * Covers both causes at once, because they are the same arithmetic and the
     * user cannot tell them apart from the number anyway: weights that were
     * mis-entered, and weight sitting in a category nothing has been marked in
     * yet. Splitting them meant two warnings restating one fact.
     */
    | "RENORMALIZED"
    /** A row claims to be scored but carries no score; it counts as ungraded. */
    | "MISSING_SCORE"
    /** A row has a max of zero or less, so it cannot be divided by. */
    | "INVALID_MAX";
  categoryId?: string;
  entryId?: string;
  detail: string;
}

export interface EntrySummary {
  id: string;
  /** Carried through so the forecast can tell a guess from a returned mark. */
  status: GradeStatus;
  /** Share of the final grade this row accounts for, 0-1. Zero unless counted. */
  weight: number;
  /** This row's end-term share before the current-grade renormalization. */
  finalWeight: number;
  /** points / max. null unless scored. */
  percent: number | null;
  /** (percent - 1) x weight -- signed contribution to the deviation from 100%. */
  impact: number;
  /** Whether this row moves the current grade. */
  counted: boolean;
  /** Share of the final grade this row still leaves undecided. */
  atStake: number;
}

export interface CategorySummary {
  id: string;
  /** Share of the final grade the category's GRADED work accounts for, after
   *  renormalization. This is the number the impact column is built on. */
  weight: number;
  /** End-term share represented by the category's currently scored rows. */
  finalWeight: number;
  /** The category's share of the FINAL grade: as entered for FIXED, as resolved
   *  from the residual for POOLED. What a syllabus would print. */
  syllabusWeight: number;
  /** Category percentage after its optional curve. null if nothing is graded. */
  percent: number | null;
  /** Sum of points over sum of max before the optional curve. */
  rawPercent: number | null;
  impact: number;
  /** Total points possible across the rows that ARE scored. */
  gradedPoints: number;
  /** Raw points still unscored. */
  atStakePoints: number;
  /**
   * How many rows are still unscored.
   *
   * The counterpart to `atStakePoints`: a category weighed evenly cares how
   * many assignments are left, not how many points, because that is the unit
   * its weight is divided in.
   */
  atStakeCount: number;
  /** Those points as a share of the final grade. */
  atStakePercent: number;
  entries: EntrySummary[];
}

export interface GradeSummary {
  categories: CategorySummary[];
  /**
   * The share of the final grade the POOLED categories divide between them:
   * whatever the fixed weights left over. 0 when nothing is pooled.
   */
  pooledResidual: number;
  /** The current course grade as a fraction. null if nothing is graded at all. */
  percent: number | null;
  /** percent - 1, and equal to the sum of every category impact. */
  impact: number;
  /** Share of the final grade not yet decided. */
  atStakePercent: number;
  warnings: GradeWarning[];
}
