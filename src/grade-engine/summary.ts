import { DEFAULT_GRADE_CONFIG, type GradeConfig } from "./config.js";
import { applyCurve } from "./curve.js";
import {
  atStakeWeights,
  canonical,
  countsTowardAtStake,
  countsTowardTotal,
  gradedWeights,
  hasDenominator,
  isScored,
} from "./weights.js";
import type {
  CategorySummary,
  EntrySummary,
  GradeCategory,
  GradeEntry,
  GradeSummary,
  GradeWarning,
} from "./types.js";

/**
 * The whole deterministic grade sheet, from raw rows.
 *
 * Pure and fast enough to run on every keystroke, which is why the client calls
 * it directly and the server only stores rows. Nothing here is cached and
 * nothing is stored -- the sheet is always a function of the entries, the same
 * way XP is always a function of the event log.
 *
 * The column that holds it together is IMPACT: `(percent - 1) x weight`, a
 * signed contribution to the distance from a perfect grade. It telescopes --
 * without a category curve, row impacts sum to their category's. Category
 * impacts always sum to the course's; a curve is the explicit category-level
 * adjustment between those two layers.
 *
 * See SHEET-NOTES.md for the spreadsheet this reproduces, formula by formula.
 */
export function summarize(
  categories: readonly GradeCategory[],
  config: GradeConfig = DEFAULT_GRADE_CONFIG,
): GradeSummary {
  const warnings: GradeWarning[] = [];
  const cats = canonical(categories);

  for (const category of cats) {
    for (const entry of canonical(category.entries)) {
      // A missing max is a row you have not finished entering, not an error.
      // It sits inert until you know what it is out of.
      if (entry.max !== null && entry.max <= 0) {
        warnings.push({
          code: "INVALID_MAX",
          categoryId: category.id,
          entryId: entry.id,
          detail: `"${entry.name}" is out of ${entry.max} points, so it cannot be scored.`,
        });
      } else if (hasDenominator(entry) && countsTowardTotal(entry.status) && entry.points === null) {
        warnings.push({
          code: "MISSING_SCORE",
          categoryId: category.id,
          entryId: entry.id,
          detail: `"${entry.name}" is marked ${entry.status.toLowerCase()} but has no score, so it is not counted.`,
        });
      }
    }
  }

  // ---- Where each category's share of the FINAL grade comes from ----------
  //
  // POOLED categories have no weight of their own. They collapse into ONE
  // virtual category holding every pooled row, weighted by the residual the
  // fixed categories left behind -- which is precisely what total-points
  // marking means. Per-category numbers fall back out by summing, so pooling is
  // a display grouping and never a separate rule.

  const fixed = cats.filter((c) => c.weightMode === "FIXED");
  const pooled = cats.filter((c) => c.weightMode === "POOLED");
  const fixedTotal = sumOf(fixed.map((c) => c.weight));
  const residual = pooled.length > 0 ? Math.max(0, 1 - fixedTotal) : 0;

  if (pooled.length > 0 && fixedTotal > 1 + config.weightEpsilon) {
    warnings.push({
      code: "FIXED_EXCEEDS_100",
      detail: `Fixed weights already total ${(fixedTotal * 100).toFixed(2)}%, leaving nothing for the ${pooled.length} pooled ${pooled.length === 1 ? "category" : "categories"}.`,
    });
  }

  // ---- Two normalizations, two questions ---------------------------------
  //
  // "What is my grade?" can only be answered over work that has been marked, so
  // weight belonging to a category with nothing graded is redistributed to the
  // categories that do have marks. In week one that makes your one returned
  // problem set your entire grade, which is the honest reading of "so far".
  //
  // "How much is still undecided?" is a question about the FINAL grade, so it
  // keeps unmarked-but-assigned categories in play and drops only categories
  // with no rows at all. A course you have entered no syllabus for cannot have
  // a share of anything.
  //
  // The spreadsheet keeps these as two separate columns (H/I and K/L) for the
  // same reason. Using one for both is the mistake this comment exists to stop.

  const roster = (category: GradeCategory) =>
    canonical(category.entries).filter(
      (e) => hasDenominator(e) && (isScored(e) || countsTowardAtStake(e.status)),
    );
  const rosterMax = (category: GradeCategory) => sumOf(roster(category).map((e) => e.max ?? 0));

  const pooledRosterMax = sumOf(pooled.map(rosterMax));
  const claimOf = (category: GradeCategory): number =>
    category.weightMode === "FIXED"
      ? rosterMax(category) > 0
        ? category.weight
        : 0
      : pooledRosterMax > 0
        ? (residual * rosterMax(category)) / pooledRosterMax
        : 0;

  const claimTotal = sumOf(cats.map(claimOf));
  const claimScale = reciprocal(claimTotal);
  /** The category's share of the FINAL grade -- what a syllabus would print. */
  const syllabusWeightOf = (category: GradeCategory) => claimOf(category) * claimScale;

  const weightOf = new Map<string, number>();
  const stakeOf = new Map<string, number>();
  const absorb = (from: Map<string, number>, into: Map<string, number>) => {
    for (const [id, value] of from) into.set(id, value);
  };

  for (const category of cats) {
    absorb(atStakeWeights(category.entries, syllabusWeightOf(category), byMax(category)), stakeOf);
  }
  for (const category of fixed) {
    absorb(gradedWeights(category.entries, category.weight, byMax(category)), weightOf);
  }
  if (pooled.length > 0) {
    // One roster, one denominator: "total points" is points-proportional by
    // definition, so `weightByMax` does not apply across a pool.
    absorb(gradedWeights(pooled.flatMap((c) => c.entries), residual, true), weightOf);
  }

  const gradedWeightTotal = sumOf([...weightOf.values()]);
  const scale = reciprocal(gradedWeightTotal);

  // One warning, both causes. It fires only when a percentage is actually
  // being shown -- an empty gradebook renormalizes nothing, so there is no
  // number to caveat and nothing to say.
  if (scale > 0 && Math.abs(gradedWeightTotal - 1) > config.weightEpsilon) {
    warnings.push({
      code: "RENORMALIZED",
      detail: `Categories with graded work total ${(gradedWeightTotal * 100).toFixed(2)}% of the final grade, not 100%; the percentage shown is renormalized over that much.`,
    });
  }

  // ---- The sheet ---------------------------------------------------------

  const summaries: CategorySummary[] = cats.map((category) => {
    const entries = canonical(category.entries);
    const scored = entries.filter(isScored);

    const entrySummaries: EntrySummary[] = entries.map((entry) => {
      const weight = (weightOf.get(entry.id) ?? 0) * scale;
      const percent =
        hasDenominator(entry) && entry.points !== null ? entry.points / entry.max! : null;
      const counted = isScored(entry);
      return {
        id: entry.id,
        status: entry.status,
        weight,
        percent,
        impact: counted && percent !== null ? (percent - 1) * weight : 0,
        counted,
        atStake: stakeOf.get(entry.id) ?? 0,
      };
    });

    const rawPercent = categoryPercent(scored, byMax(category));
    const percent = rawPercent === null ? null : applyCurve(rawPercent, category);
    const weight = sumOf(entrySummaries.map((e) => e.weight));

    return {
      id: category.id,
      weight,
      syllabusWeight: syllabusWeightOf(category),
      percent,
      rawPercent,
      // Entry rows remain raw. A category curve is applied once to their
      // aggregate, so its category-level impact must be rebuilt from that
      // curved percentage rather than summing the raw row impacts.
      impact: percent === null ? 0 : (percent - 1) * weight,
      gradedPoints: sumOf(scored.map((e) => e.max ?? 0)),
      atStakePoints: sumOf(
        entries
          .filter((e) => countsTowardAtStake(e.status) && hasDenominator(e))
          .map((e) => e.max ?? 0),
      ),
      atStakeCount: entries.filter((e) => countsTowardAtStake(e.status) && hasDenominator(e))
        .length,
      atStakePercent: sumOf(entrySummaries.map((e) => e.atStake)),
      entries: entrySummaries,
    };
  });

  const impact = sumOf(summaries.map((c) => c.impact));

  return {
    categories: summaries,
    pooledResidual: residual,
    percent: scale > 0 ? 1 + impact : null,
    impact,
    atStakePercent: sumOf(summaries.map((c) => c.atStakePercent)),
    warnings,
  };
}

/**
 * A category's own percentage.
 *
 * Points-proportional is total-over-total. Flat weighting is the plain MEAN of
 * the row percentages -- NOT total-over-total, which would silently reintroduce
 * point size through the back door and break the telescoping invariant, since
 * flat entry weights make every impact `(p_i - 1) x W/n`.
 */
function categoryPercent(scored: readonly GradeEntry[], byMax: boolean): number | null {
  if (scored.length === 0) return null;
  if (byMax) {
    const max = sumOf(scored.map((e) => e.max ?? 0));
    return max > 0 ? sumOf(scored.map((e) => e.points ?? 0)) / max : null;
  }
  return sumOf(scored.map((e) => (e.points ?? 0) / (e.max ?? 1))) / scored.length;
}

/** Pooling is points-proportional by definition; the toggle cannot apply. */
function byMax(category: GradeCategory): boolean {
  return category.weightMode === "POOLED" ? true : category.weightByMax;
}

/**
 * `1 / total`, or 0 when that is not a usable number.
 *
 * Renormalization divides by a sum of weights, and a sum small enough to
 * overflow the reciprocal would turn the whole sheet into NaN. A course whose
 * weights are collectively that close to zero has no grade to report, so the
 * degenerate answer and the "nothing graded yet" answer are the same one.
 */
function reciprocal(total: number): number {
  const inverse = 1 / total;
  return total > 0 && Number.isFinite(inverse) ? inverse : 0;
}

/** Sorted before summing: float addition is not associative. */
function sumOf(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b).reduce((total, value) => total + value, 0);
}
