import { DEFAULT_GRADE_CONFIG, type GradeConfig } from "./config.js";
import { applyCurveInterval } from "./curve.js";
import { studentTQuantile } from "./distribution.js";
import { canonical, countsTowardAtStake, hasDenominator, isScored } from "./weights.js";
import type { CategorySummary, EntrySummary, GradeCategory, GradeSummary } from "./types.js";

/**
 * What the ungraded part of a course is likely to do to it.
 *
 * The deterministic sheet answers "where do I stand"; this answers "where could
 * I end up". Each category's graded rows are treated as a sample of how you
 * perform in that category, and the remaining work is projected through a
 * PREDICTION interval built from that sample -- prediction rather than
 * confidence, because the question is what the next assignment scores, not
 * where the true mean lies. The `sqrt(1 + 1/n)` term is what separates the two.
 *
 * Reproduces the spreadsheet's forecast columns exactly; see SHEET-NOTES.md.
 */

export interface Interval {
  low: number;
  high: number;
}

export interface CategoryForecast {
  id: string;
  /** Weighted standard deviation of the scored rows. The STD. DEV. column. */
  sd: number;
  /** Kish effective sample size -- how many equally-weighted rows this is worth. */
  effectiveSampleSize: number;
  /** Half-width of the prediction band around the mean. */
  band: number;
  /** Projected score on this category's REMAINING work, as a fraction. */
  expected: Interval;
  /** The projected remaining-work score before the category curve. */
  rawExpected: Interval;
  /** Projected FINAL percentage for the category. null when it has no rows. */
  result: Interval | null;
  /** The projected final category percentage before the category curve. */
  rawResult: Interval | null;
  /** Move in the COURSE grade if the remaining work lands at the top of its band. */
  standToGain: number;
  /** ...and at the bottom. Negative. */
  standToLose: number;
}

export interface Forecast {
  categories: CategoryForecast[];
  sd: number;
  effectiveSampleSize: number;
  band: number;
  expected: Interval;
  result: Interval | null;
  standToGain: number;
  standToLose: number;
}

/**
 * Weighted sample variance -- the sheet's own `WEIGHTEDVAR` named function.
 *
 * The `(sumW^2 - sumSqW) / sumW` denominator is the weighted analogue of the
 * `n - 1` in an unbiased variance: it collapses to exactly `n - 1` when every
 * weight is equal, and shrinks toward zero as one row comes to dominate.
 * Scale-invariant in the weights, so it does not matter whether they are raw
 * point values or normalized shares of a grade.
 */
export function weightedVariance(values: readonly number[], weights: readonly number[]): number {
  const sumW = sum(weights);
  if (sumW <= 0) return 0;
  const mean = weightedMean(values, weights);
  const denominator = (sumW * sumW - sum(weights.map((w) => w * w))) / sumW;
  if (denominator <= 0) return 0;
  return sum(values.map((v, i) => weights[i]! * (v - mean) ** 2)) / denominator;
}

/** Kish's effective sample size: `(sum w)^2 / sum w^2`. */
export function effectiveSampleSize(weights: readonly number[]): number {
  const sumSq = sum(weights.map((w) => w * w));
  if (sumSq <= 0) return 1;
  return sum(weights) ** 2 / sumSq;
}

export function forecast(
  categories: readonly GradeCategory[],
  summary: GradeSummary,
  config: GradeConfig = DEFAULT_GRADE_CONFIG,
): Forecast {
  const cats = canonical(categories);

  // The course-level band pools EVERY scored row at its course weight, rather
  // than combining the per-category bands -- a course is one sample of your
  // work, and combining intervals would double-count the shared uncertainty.
  // It is computed first because it is also what anchors each category's prior.
  // ONE pool, with every row weighted by the setting of the category it came
  // from -- not by whichever category happens to be reading it. That keeps the
  // pool a single well-defined object and makes a category's setting mean the
  // same thing wherever its rows turn up.
  const pooled = summary.categories.flatMap((c, i) =>
    c.entries
      .filter((e) => e.counted)
      .map((e) => ({
        value: sampleValue(e.percent ?? 0, capOf(cats[i]!, config)),
        weight: sampleWeight(e, estimateWeightOf(cats[i]!, config)),
      })),
  );
  const values = pooled.map((r) => r.value);
  const weights = pooled.map((r) => r.weight);
  const courseSample = { values, weights };

  /** The real grade. Gain and lose are measured against this, not the sample. */
  const mean = summary.percent ?? 0;
  const graded = summary.percent !== null;

  // The forecast is centred on what it INFERRED from, which under the cap is
  // the clamped pool. Identical to the grade whenever nothing was clamped.
  const pooledCentre = weights.some((w) => w > 0) ? weightedMean(values, weights) : null;
  const forecastCentre = pooledCentre ?? config.forecastPrior.mean;
  /** What a category with nothing of its own is assumed to look like. */
  const centre = graded ? forecastCentre : config.forecastPrior.mean;

  const { sd, nEff, band } = predict(values, weights, centre, config.alpha, config);

  const categoryForecasts = summary.categories.map((summarized, i) =>
    forecastCategory(cats[i]!, summarized, courseSample, centre, config),
  );

  const share = (c: CategorySummary) => c.syllabusWeight;
  const project = (pick: (f: CategoryForecast) => number) =>
    sum(
      categoryForecasts.map((f, i) =>
        f.result === null ? 0 : pick(f) * share(summary.categories[i]!),
      ),
    );

  const high = project((f) => f.result!.high);
  const low = project((f) => f.result!.low);
  const deadzone = (x: number) => (Math.abs(x) < config.gainLoseDeadzone ? 0 : x);

  // Per-category gain/lose swaps ONE category's current average for its
  // projected best or worst and reports the move in the COURSE grade -- so the
  // figures are answers to "how much does this one category still matter",
  // measured on the scale you actually care about. A category with nothing
  // outstanding reports zero on both sides.
  //
  // What each category is assumed to be worth before anything is projected.
  //
  // A category with no marks is assumed to land at the COURSE average, not at
  // 100%. The spreadsheet assumes 100%, and that is where its gain/lose columns
  // go wrong: it makes the baseline sit above the current grade by a constant,
  // and since the per-category figures subtract the current grade rather than
  // the baseline, that constant is added to EVERY row -- so a category with
  // nothing outstanding still reports a swing. With `?? mean` the baseline
  // equals the current grade exactly (the graded categories' shares are
  // proportional to their renormalized weights, so both sides collapse to the
  // same number), the constant vanishes, and each row reports only the move its
  // OWN outstanding work can cause. Which is what makes the column add up.
  const assume = (c: CategorySummary) => (c.percent ?? mean) * share(c);

  /**
   * The projected final grade if every category lands where it is currently
   * expected to -- and the reference BOTH stand-to figures are measured from.
   *
   * Not the current grade. The gap between the two is real but is not
   * something you "stand to" do anything about: it is just the arithmetic of
   * unmarked work being excluded from today's percentage and included in the
   * final one. Measuring against it put that gap into every category's swing,
   * including categories with nothing outstanding.
   *
   * It has to be the baseline rather than `mean` because the two weightings
   * are not proportional in general. A POOLED category's share of the current
   * grade goes by its GRADED points while its share of the final grade goes by
   * its whole roster, so `sum(assume) != mean` the moment two pooled
   * categories have different proportions marked. Against the baseline the
   * category figures sum to the course figure by construction, whatever the
   * weighting.
   */
  const baseline = sum(summary.categories.map(assume));

  for (let i = 0; i < categoryForecasts.length; i++) {
    const f = categoryForecasts[i]!;
    const c = summary.categories[i]!;
    if (f.result === null) continue;
    const swap = (projected: number) => projected * share(c) - assume(c);
    f.standToGain = deadzone(swap(f.result.high));
    f.standToLose = deadzone(swap(f.result.low));
  }

  return {
    categories: categoryForecasts,
    sd,
    effectiveSampleSize: nEff,
    band,
    expected: graded
      ? clampBand(forecastCentre, band, config.capForecastAtFull, config, softAnchor(values))
      : { low: 0, high: 1 },
    result: categoryForecasts.some((f) => f.result !== null) ? { low, high } : null,
    standToGain: deadzone(high - baseline),
    standToLose: deadzone(low - baseline),
  };
}

function forecastCategory(
  category: GradeCategory,
  summarized: CategorySummary,
  courseSample: { values: number[]; weights: number[] },
  centre: number,
  config: GradeConfig,
): CategoryForecast {
  const estimateWeight = estimateWeightOf(category, config);
  const cap = capOf(category, config);
  const scored = summarized.entries.filter((e) => e.counted);
  const own = {
    values: scored.map((e) => sampleValue(e.percent ?? 0, cap)),
    weights: scored.map((e) => sampleWeight(e, estimateWeight)),
  };

  // Centred on its OWN marks when it has any, even when borrowing the course's
  // spread -- and on the clamped version of them, so the centre is a value the
  // cap admits is reachable.
  const ownCentre = own.weights.some((w) => w > 0) ? weightedMean(own.values, own.weights) : null;

  // What the category actually knows about itself, which is not the same as how
  // many rows it has: with estimates excluded, a category that is ENTIRELY
  // estimates knows nothing, and must fall back rather than sit on a sample of
  // zero-weight rows pretending otherwise.
  const evidence = own.weights.filter((w) => w > 0).length;

  // Which marks this category's forecast listens to. `COURSE_WHEN_SPARSE` hands
  // over only when the category has nothing of its own -- once it has even one
  // mark, that mark plus the prior beats a course average drawn from work of a
  // different kind.
  const basis = category.forecastBasis ?? config.defaultBasis;
  const sample =
    basis === "COURSE" ||
    (basis === "COURSE_WHEN_SPARSE" && evidence < config.sparseObservations)
      ? courseSample
      : own;

  const alpha = category.alphaOverride ?? config.alpha;
  const { sd, nEff, band } = predict(sample.values, sample.weights, centre, alpha, config);

  // A category carrying no weight has nothing of its own to say. It still gets
  // a band when it is borrowing the course's marks -- that is the entire point
  // of borrowing them.
  const informative =
    sample === courseSample
      ? courseSample.weights.some((w) => w > 0)
      : summarized.weight > 0 && evidence > 0;
  const mean =
    ownCentre ??
    (informative ? posteriorMean(sample.values, sample.weights, centre, config) : 0);
  // With nothing to go on, the span is 0-100 whatever the cap says: extra
  // credit is a claim about a category's marking, and an empty category has
  // made no such claim.
  const rawExpected = informative
    ? clampBand(mean, band, cap, config, softAnchor(sample.values))
    : { low: 0, high: 1 };
  const expected = applyCurveInterval(rawExpected, category);

  // Flat weighting counts assignments; points-proportional counts points. The
  // projection has to be measured in whichever unit the category is weighed in,
  // or a 5-point quiz would move the average as much as a 100-point exam.
  const flat = category.weightMode === "FIXED" && !category.weightByMax;
  const entries = canonical(category.entries);
  const scoredRows = entries.filter(isScored);
  const pending = entries.filter((e) => countsTowardAtStake(e.status) && hasDenominator(e));

  const current = flat ? scoredRows.length : sum(scoredRows.map((e) => e.max ?? 0));
  // Points ALREADY BANKED, which is a fact about the past and must not use the
  // forecast's centre: under the cap that centre is clamped, and a flat
  // category reconstructing its earnings from it would understate what it
  // actually scored -- reporting a swing for a category with nothing left to
  // play for.
  const standing = summarized.rawPercent ?? summarized.percent ?? 0;
  const earned = flat ? standing * current : sum(scoredRows.map((e) => e.points ?? 0));
  const atStake = flat ? pending.length : sum(pending.map((e) => e.max ?? 0));
  const total = current + atStake;

  // Whole points, since that is how work is actually marked -- the rounding is
  // deliberate and matches the sheet.
  const projected = (bound: number) => (flat ? bound * atStake : Math.round(bound * atStake));
  const rawResult =
    total > 0
      ? {
          low: (earned + projected(rawExpected.low)) / total,
          high: (earned + projected(rawExpected.high)) / total,
        }
      : null;
  const result = rawResult === null ? null : applyCurveInterval(rawResult, category);

  return {
    id: summarized.id,
    sd,
    effectiveSampleSize: nEff,
    band,
    expected,
    rawExpected,
    result,
    rawResult,
    standToGain: 0,
    standToLose: 0,
  };
}

/**
 * The posterior predictive for the NEXT mark in a sample.
 *
 * Observations are taken as `x_i ~ N(mu, sigma^2)` with both unknown, under a
 * conjugate normal-inverse-gamma prior. The posterior predictive for one more
 * observation is then a Student's t:
 *
 *   kappa_n = kappa_0 + n            mu_n  = (kappa_0*mu_0 + n*xbar) / kappa_n
 *   alpha_n = alpha_0 + n/2          beta_n = beta_0 + S/2
 *                                             + kappa_0*n*(xbar - mu_0)^2 / (2*kappa_n)
 *   x_new ~ t(2*alpha_n) centred on mu_n, scale^2 = beta_n(kappa_n + 1) / (alpha_n*kappa_n)
 *
 * which is exactly the behaviour a grade sheet needs and the plain sample
 * variance cannot give:
 *
 *  - ZERO marks yields the prior's width rather than an error.
 *  - ONE mark yields a real interval. `S = 0` contributes nothing, but `beta_0`
 *    is still there, so the width is the prior's, recentred.
 *  - n IDENTICAL marks of k narrows around k like 1/sqrt(n) instead of
 *    collapsing to a point. `S` stays 0, but `alpha_n` grows with n, and
 *    `beta_n / alpha_n` shrinks accordingly. Certainty has to be earned by
 *    repetition, not asserted by a single number.
 *
 * `n` here is the Kish effective sample size, so unequally weighted rows count
 * for what they are actually worth.
 */
function predict(
  values: readonly number[],
  weights: readonly number[],
  centre: number,
  alpha: number,
  config: GradeConfig,
): { sd: number; nEff: number; band: number } {
  const { observations: k0, degreesOfFreedom: v0, stdDev: s0 } = config.forecastPrior;
  const nEff = weights.length > 0 ? effectiveSampleSize(weights) : 0;
  const sd = weights.length > 0 ? Math.sqrt(weightedVariance(values, weights)) : 0;

  // Sum of squared deviations, in effective-observation units. The unbiased
  // weighted variance carries n - 1 degrees of freedom, so this inverts it.
  const scatter = nEff > 1 ? weightedVariance(values, weights) * (nEff - 1) : 0;
  const mean = weights.length > 0 ? weightedMean(values, weights) : centre;

  const a0 = v0 / 2;
  const b0 = (v0 * s0 * s0) / 2;
  const kn = k0 + nEff;
  const an = a0 + nEff / 2;
  const bn =
    b0 + scatter / 2 + (kn > 0 ? (k0 * nEff * (mean - centre) ** 2) / (2 * kn) : 0);

  const df = 2 * an;
  const scaleSquared = kn > 0 && an > 0 ? (bn * (kn + 1)) / (an * kn) : 0;
  if (!(df > 0) || !(scaleSquared > 0)) return { sd, nEff, band: 0 };

  const degrees = config.truncateDegreesOfFreedom ? Math.max(1, Math.floor(df)) : df;
  const t = studentTQuantile(1 - alpha / 2, degrees);
  return { sd, nEff, band: t * Math.sqrt(scaleSquared) };
}

/**
 * What a row is worth as EVIDENCE, which is not what it is worth to the grade.
 *
 * An estimated mark counts in full toward the percentage -- it is your best
 * information about where you stand -- while counting for `estimateWeight` of
 * an observation when the question is how predictable you are. The two are
 * different questions and this is the only place they diverge.
 */
function sampleWeight(entry: EntrySummary, estimateWeight: number): number {
  return entry.status === "ESTIMATED" ? entry.weight * estimateWeight : entry.weight;
}

/** A category's own setting for its estimates, or the course default. */
function estimateWeightOf(category: GradeCategory, config: GradeConfig): number {
  return category.estimateWeight ?? config.estimateWeight;
}

/** A category's own setting for the 100% ceiling, or the course default. */
function capOf(category: GradeCategory, config: GradeConfig): boolean {
  return category.capForecast ?? config.capForecastAtFull;
}

/**
 * What a mark is worth as EVIDENCE about the next one.
 *
 * Under the cap, a 132% is evidence that you hit the ceiling -- not that you
 * can exceed it, since the cap says you cannot. So it enters the sample as
 * 100%. Inferring on the raw 132% and truncating the answer afterwards would
 * measure a spread the cap forbids, and would let the interval collapse to a
 * point that no prior could widen.
 *
 * Like the estimate weight, this belongs to the ROW's own category: a category
 * that allows extra credit contributes unclamped marks even to a pool that
 * some capped category is reading.
 */
function sampleValue(percent: number, cap: boolean): number {
  return cap ? Math.min(percent, 1) : percent;
}

/** Where the posterior predictive is centred, given the prior pulls toward `centre`. */
function posteriorMean(
  values: readonly number[],
  weights: readonly number[],
  centre: number,
  config: GradeConfig,
): number {
  const k0 = config.forecastPrior.observations;
  const nEff = weights.length > 0 ? effectiveSampleSize(weights) : 0;
  const kn = k0 + nEff;
  if (kn <= 0) return centre;
  return (k0 * centre + nEff * (weights.length > 0 ? weightedMean(values, weights) : centre)) / kn;
}

/**
 * A band around the mean, held inside the range a score can occupy.
 *
 * Two modes, and the difference is an assumption about the future rather than a
 * fact about the past:
 *
 *  - CAPPED clamps both ends into [0, 100]. A category averaging 110% forecasts
 *    as [100%, 100%]. That looks strange beside a 110% current standing, and it
 *    is the honest reading of "do not assume extra credit": marks already
 *    awarded above 100 say nothing about whether more is on offer.
 *
 *  - EXTRA CREDIT anchors a soft ceiling midway between the best and second-best
 *    marks, or 100% if that is higher -- there is no reason to penalise the
 *    ordinary range, and no reason to let one outlier set the ceiling alone.
 *    Past the anchor the band keeps growing at `extraCreditDamping` of its rate,
 *    so exceeding what you have demonstrated is possible but not free.
 *
 * Neither mode can invert: clamping preserves order, and the soft ceiling is
 * monotone in its input.
 */
function clampBand(mean: number, band: number, cap: boolean, config: GradeConfig, softCeiling: number): Interval {
  if (cap) {
    const clamp = (x: number) => Math.min(Math.max(x, 0), 1);
    return { low: clamp(mean - band), high: clamp(mean + band) };
  }
  const anchor = Math.max(1, softCeiling);
  const raw = mean + band;
  const high = raw <= anchor ? raw : anchor + (raw - anchor) * config.extraCreditDamping;
  return { low: Math.max(0, mean - band), high };
}

/**
 * Where the soft ceiling's kink sits: halfway between the best mark and the
 * second best.
 *
 * Not the maximum itself. A single outlier -- one 132% among four 100s --
 * pushes a maximum-anchored kink beyond the band's own reach, so the damping
 * never engages in exactly the case it exists for. The midpoint keeps one
 * exceptional mark from carrying the anchor on its own: it has to drag the
 * runner-up with it.
 *
 * With one observation there is no gap to split, so the mark anchors itself.
 * With ties the midpoint is the tied value, which is what you want -- two marks
 * at 107% really is evidence that 107% is reachable.
 */
function softAnchor(values: readonly number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => b - a);
  const highest = sorted[0]!;
  return (highest + (sorted[1] ?? highest)) / 2;
}

function weightedMean(values: readonly number[], weights: readonly number[]): number {
  const sumW = sum(weights);
  return sumW > 0 ? sum(values.map((v, i) => v * weights[i]!)) / sumW : 0;
}

function sum(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b).reduce((total, value) => total + value, 0);
}
