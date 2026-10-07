import type { ForecastBasis } from "./types.js";

/**
 * Every tunable number the grade sheet uses.
 *
 * Same rule as the XP engine: nothing gets inlined into a formula. The list is
 * short today because the deterministic layer is almost parameter-free -- the
 * forecast layer (Expected / Std. Dev. / Result / Stand to Gain-Lose) is where
 * the real constants land.
 */
export interface GradeConfig {
  /**
   * Tolerance for "do these weights add up to 100%?".
   *
   * A syllabus written as 1/3 + 1/3 + 1/3 cannot sum to exactly 1 in binary
   * floating point, and warning about that would be noise.
   */
  weightEpsilon: number;
  /**
   * Significance level for the forecast band: an interval of (1 - alpha).
   *
   * 0.2 -- an 80% interval, carried over from the spreadsheet. Wider than the
   * reflexive 0.05 on purpose: a 95% band over four graded assignments spans
   * nearly the whole scale and tells you nothing you did not know.
   */
  alpha: number;
  /**
   * Whether to truncate degrees of freedom to a whole number before taking the
   * t quantile.
   *
   * The effective sample size is fractional, and Sheets' `T.INV` silently
   * truncates its df argument -- so the spreadsheet has been using df=8 where
   * it asked for 8.31. Kept ON so the app and the sheet agree to the digit.
   * Turning it off is slightly more accurate and slightly narrower.
   */
  truncateDegreesOfFreedom: boolean;
  /**
   * Below this, a stand-to-gain/lose figure is reported as exactly zero.
   *
   * Rounding a projection to the nearest point leaves floating-point crumbs on
   * categories with nothing at stake, and "+0.00%" reads as a real number.
   */
  gainLoseDeadzone: number;
  /**
   * The prior belief about a category's scores, before any of them are in.
   *
   * Without one, the forecast is degenerate exactly when it matters most: a
   * single mark has no sample variance, so the "interval" is a point, and a
   * run of identical scores says the next one is certain. A conjugate
   * normal-inverse-gamma prior fixes both -- the posterior predictive is a
   * Student's t whose width starts at the prior and contracts like 1/sqrt(n)
   * as real marks accumulate, which is the behaviour you actually want.
   */
  forecastPrior: {
    /** kappa_0 -- how many observations the prior's MEAN is worth. */
    observations: number;
    /** nu_0 -- how many observations the prior's SPREAD is worth. */
    degreesOfFreedom: number;
    /** sigma_0 -- assignment-to-assignment spread assumed before any marks. */
    stdDev: number;
    /** mu_0 -- fallback centre, used only when the course has no marks at all. */
    mean: number;
  };
  /**
   * How much of an observation an ESTIMATED row is worth in the forecast
   * sample. Nothing else -- the grade itself always counts estimates in full.
   *
   * 0 excludes them: a guess cannot then narrow its own forecast. That matters
   * because the prior only stops a SINGLE mark claiming certainty; ten
   * confident guesses at 100% would drive the sample variance to zero and
   * collapse the band around a number you invented.
   *
   * 1 lets them count as ordinary marks. Anything between is a partial-credit
   * estimate, which the weighted variance and the Kish effective sample size
   * handle with no special casing at all.
   */
  estimateWeight: number;
  /**
   * Whether a forecast is held to a hard [0, 100] range.
   *
   * True by default, and it means what it says: BOTH ends clamp, so a category
   * averaging 110% forecasts as [100%, 100%]. Degenerate, and correct -- past
   * extra credit is not evidence that more is on offer, and the app should not
   * assume any without being told.
   *
   * Only the FORECAST is clamped. Percent, weight, impact and the course total
   * go on reporting 110%, because that is what happened.
   *
   * False switches to a soft ceiling anchored at the highest score actually
   * seen (or 100%, whichever is greater). Beyond that the band still grows, at
   * `extraCreditDamping` of its normal rate -- more than you have demonstrated
   * is possible, just not free.
   */
  capForecastAtFull: boolean;
  /**
   * How much of the band survives past the soft ceiling, when extra credit is
   * enabled. 0 would be a hard cap at the observed maximum; 1 no cap at all.
   *
   * A heuristic, not a result. The observed maximum is a biased-low estimate of
   * what a marking scheme can award, so some room above it is right; how much
   * is a judgement about how far to trust an extrapolation.
   */
  extraCreditDamping: number;
  /**
   * Below this many marks, a category counts as having no data of its own for
   * the `COURSE_WHEN_SPARSE` basis.
   */
  sparseObservations: number;
  /** The basis a category uses when it does not name one. */
  defaultBasis: ForecastBasis;
}

export const DEFAULT_GRADE_CONFIG: GradeConfig = {
  weightEpsilon: 1e-9,
  alpha: 0.2,
  truncateDegreesOfFreedom: true,
  gainLoseDeadzone: 1e-4,
  // Worth one assignment's say in the mean and two in the spread: enough to
  // stop a single mark claiming certainty, light enough to be washed out by
  // the fourth or fifth.
  forecastPrior: { observations: 1, degreesOfFreedom: 2, stdDev: 0.1, mean: 0.85 },
  // Excluded by default: a guess should not be able to narrow its own forecast.
  estimateWeight: 0,
  capForecastAtFull: true,
  extraCreditDamping: 0.5,
  sparseObservations: 1,
  defaultBasis: "COURSE_WHEN_SPARSE",
};

/**
 * The prior that reproduces the spreadsheet exactly.
 *
 * `kappa_0 = 0, nu_0 = -1` is the standard non-informative reference prior, and
 * it collapses the posterior predictive back to the textbook frequentist
 * interval: location `xbar`, scale `s * sqrt(1 + 1/n)`, `n - 1` degrees of
 * freedom. The old behaviour is a special case of the new one, which is what
 * lets `apLit.test.ts` go on checking the engine against the real workbook.
 */
export const FREQUENTIST_PRIOR: GradeConfig["forecastPrior"] = {
  observations: 0,
  degreesOfFreedom: -1,
  stdDev: 0,
  mean: 0,
};

