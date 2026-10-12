import type { GradeEntry, GradeStatus } from "./types.js";

/**
 * How a category's weight is spread across its rows.
 *
 * Three distributions can come out of the same category weight, and keeping
 * them separate is the whole trick:
 *
 * - the FINAL distribution prices every returned and pending row against the
 *   full roster. The default current grade renormalizes only its scored rows.
 * - the legacy GRADED distribution spreads the full category weight across rows
 *   that have scores, so a category with 3 of 14 assignments back still counts
 *   for its whole 20% under category-progress weighting.
 * - the AT-STAKE distribution measures the unscored rows against the FULL
 *   roster, so those 11 missing assignments show as 20% x 11/14 still undecided.
 *
 * The original spreadsheet's legacy mode has 11 graded participation slots each worth
 * 1.82% (summing to the full 20%), while 30 unscored points read as 4.29% at
 * stake. The two columns are answering different questions.
 */

/** Rows that move the current grade. */
export function countsTowardTotal(status: GradeStatus): boolean {
  return status === "RETURNED" || status === "ESTIMATED";
}

/** Rows that are still undecided. `POSSIBLE` is not one -- it is hypothetical. */
export function countsTowardAtStake(status: GradeStatus): boolean {
  return status === "PENDING";
}

/**
 * Canonical order.
 *
 * Float addition is not associative, so a reduction over an unsorted list gives
 * results that drift with input order and quietly breaks the telescoping
 * invariant. `sortOrder` is not unique across categories, so `id` settles ties.
 * The same reason `taskXp.ts` sorts before reducing.
 */
export function canonical<T extends { id: string; sortOrder: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A row can be divided by: it has a positive denominator. */
export function hasDenominator(entry: GradeEntry): boolean {
  return entry.max !== null && entry.max > 0;
}

/** A scored row with a usable denominator. Both halves are required. */
export function isScored(entry: GradeEntry): boolean {
  return countsTowardTotal(entry.status) && entry.points !== null && hasDenominator(entry);
}

/**
 * Spread `weight` across the rows selected by `include`.
 *
 * `byMax` picks the two modes: points-proportional (a 60-point lab outweighs a
 * 30-point one) or flat (every assignment equal regardless of size).
 */
function distribute(
  entries: readonly GradeEntry[],
  weight: number,
  byMax: boolean,
  include: (e: GradeEntry) => boolean,
  denominator: (e: GradeEntry) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  const pool = canonical(entries).filter(denominator);
  const total = byMax ? pool.reduce((sum, e) => sum + (e.max ?? 0), 0) : pool.length;
  if (total <= 0) return out;

  for (const entry of pool) {
    if (!include(entry)) continue;
    const share = byMax ? (entry.max ?? 0) / total : 1 / total;
    out.set(entry.id, weight * share);
  }
  return out;
}

/**
 * The graded distribution: the full category weight, across scored rows only.
 * Unscored rows are absent from both the numerator and the denominator.
 */
export function gradedWeights(
  entries: readonly GradeEntry[],
  weight: number,
  byMax: boolean,
): Map<string, number> {
  return distribute(entries, weight, byMax, isScored, isScored);
}

/**
 * The end-term distribution: every scored or pending row is priced against the
 * full entered roster. These weights do not change when a pending score lands.
 */
export function finalWeights(
  entries: readonly GradeEntry[],
  weight: number,
  byMax: boolean,
): Map<string, number> {
  const inRoster = (entry: GradeEntry) =>
    hasDenominator(entry) && (isScored(entry) || countsTowardAtStake(entry.status));
  return distribute(entries, weight, byMax, inRoster, inRoster);
}

/**
 * The at-stake distribution: unscored rows measured against the whole roster,
 * scored and unscored alike. `POSSIBLE` rows are in neither.
 */
export function atStakeWeights(
  entries: readonly GradeEntry[],
  weight: number,
  byMax: boolean,
): Map<string, number> {
  return distribute(
    entries,
    weight,
    byMax,
    (e) => countsTowardAtStake(e.status) && hasDenominator(e),
    (e) => hasDenominator(e) && (isScored(e) || countsTowardAtStake(e.status)),
  );
}
