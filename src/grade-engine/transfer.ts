import {
  CURRENT_GRADE_WEIGHTINGS,
  CURVE_MODES,
  FORECAST_BASES,
  GRADE_STATUSES,
  WEIGHT_MODES,
} from "./types.js";
import type {
  CurrentGradeWeighting,
  CurveMode,
  ForecastBasis,
  GradeStatus,
  WeightMode,
} from "./types.js";

/**
 * Reading and writing a gradebook as a file.
 *
 * The point is a gradebook you can keep outside the app: snapshot before a
 * risky edit, diff two terms, hand a course structure to someone else. So the
 * format is plain JSON with stable key names rather than anything clever, and
 * it deliberately carries NO ids -- an import creates fresh rows rather than
 * trying to reconcile with what is already there.
 *
 * Parsing is total: it either returns a whole valid gradebook or an error
 * naming the exact path that failed. Nothing half-read ever reaches the
 * database, which is what makes "overwrite on import" safe to offer.
 */

/** Bumped only when a change would make an older file unreadable. */
export const GRADEBOOK_FORMAT = 1;

export interface GradebookEntry {
  name: string;
  points: number | null;
  max: number | null;
  status: GradeStatus;
  notes: string | null;
}

export interface GradebookCategory {
  name: string;
  /** Preferred width of the assignment-name column in pixels. Older files
   *  omit it and use the interface default. */
  nameColumnWidth?: number;
  weightMode: WeightMode;
  weight: number;
  weightByMax: boolean;
  alphaOverride: number | null;
  forecastBasis: ForecastBasis | null;
  /** null inherits. Numeric rather than a flag, so the file can carry the
   *  partial-credit weights the engine supports even if no UI sets them. */
  estimateWeight: number | null;
  /** null inherits. Whether this category's forecast is held to 100%. */
  capForecast: boolean | null;
  curveEnabled?: boolean;
  curveMode?: CurveMode;
  curveAddend?: number;
  curveMultiplier?: number;
  curveExpression?: string;
  curveCap?: boolean;
  entries: GradebookEntry[];
}

export interface GradebookFile {
  questlogGradebook: number;
  exportedAt: string;
  /** Which course this came from. Never applied on import -- it is a label. */
  course?: { name: string; emoji: string };
  /**
   * The course-wide forecast settings in force when the file was written, and
   * applied on import so a snapshot restores the numbers it recorded.
   *
   * These are global to the user rather than to the course, so importing one
   * course's file re-tunes every course's forecast. That is the deliberate
   * price of a snapshot that actually round-trips: a restore that leaves you
   * looking at different numbers is not a restore. Omit the block and nothing
   * global is touched.
   */
  settings?: {
    currentWeighting: CurrentGradeWeighting;
    alpha: number;
    basis: ForecastBasis;
    estimateWeight: number;
    capForecast: boolean;
  };
  categories: GradebookCategory[];
}

export type ParseResult =
  | { ok: true; value: GradebookFile }
  | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or a precise complaint about where it was not one. */
function readNumber(value: unknown, path: string, opts: { min?: number; max?: number } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false as const, error: `${path} must be a number.` };
  }
  if (opts.min !== undefined && value < opts.min) {
    return { ok: false as const, error: `${path} must be at least ${opts.min}.` };
  }
  if (opts.max !== undefined && value > opts.max) {
    return { ok: false as const, error: `${path} must be at most ${opts.max}.` };
  }
  return { ok: true as const, value };
}

function readOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return { ok: false, error: `${path} must be one of ${allowed.join(", ")}.` };
  }
  return { ok: true, value: value as T };
}

function parseEntry(raw: unknown, path: string): { ok: true; value: GradebookEntry } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `${path} must be an object.` };
  if (typeof raw.name !== "string") {
    return { ok: false, error: `${path}.name must be a string.` };
  }

  const status = readOneOf(raw.status ?? "PENDING", GRADE_STATUSES, `${path}.status`);
  if (!status.ok) return status;

  let points: number | null = null;
  if (raw.points !== null && raw.points !== undefined) {
    const read = readNumber(raw.points, `${path}.points`);
    if (!read.ok) return read;
    points = read.value;
  }

  let max: number | null = null;
  if (raw.max !== null && raw.max !== undefined) {
    const read = readNumber(raw.max, `${path}.max`, { min: Number.MIN_VALUE });
    if (!read.ok) return { ok: false, error: `${path}.max must be a positive number.` };
    max = read.value;
  }

  if (raw.notes !== null && raw.notes !== undefined && typeof raw.notes !== "string") {
    return { ok: false, error: `${path}.notes must be a string.` };
  }

  return {
    ok: true,
    value: { name: raw.name, points, max, status: status.value, notes: (raw.notes as string) ?? null },
  };
}

function parseCategory(raw: unknown, path: string): { ok: true; value: GradebookCategory } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `${path} must be an object.` };
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    return { ok: false, error: `${path}.name must be a non-empty string.` };
  }

  const mode = readOneOf(raw.weightMode ?? "FIXED", WEIGHT_MODES, `${path}.weightMode`);
  if (!mode.ok) return mode;

  const weight = readNumber(raw.weight ?? 0, `${path}.weight`, { min: 0, max: 1 });
  if (!weight.ok) return weight;

  if (raw.weightByMax !== undefined && typeof raw.weightByMax !== "boolean") {
    return { ok: false, error: `${path}.weightByMax must be true or false.` };
  }

  let nameColumnWidth: number | undefined;
  if (raw.nameColumnWidth !== undefined) {
    const read = readNumber(raw.nameColumnWidth, `${path}.nameColumnWidth`, { min: 80, max: 420 });
    if (!read.ok) return read;
    nameColumnWidth = Math.round(read.value);
  }

  let alphaOverride: number | null = null;
  if (raw.alphaOverride !== null && raw.alphaOverride !== undefined) {
    const read = readNumber(raw.alphaOverride, `${path}.alphaOverride`);
    if (!read.ok || read.value <= 0 || read.value >= 1) {
      return { ok: false, error: `${path}.alphaOverride must be between 0 and 1, exclusive.` };
    }
    alphaOverride = read.value;
  }

  let forecastBasis: ForecastBasis | null = null;
  if (raw.forecastBasis !== null && raw.forecastBasis !== undefined) {
    const read = readOneOf(raw.forecastBasis, FORECAST_BASES, `${path}.forecastBasis`);
    if (!read.ok) return read;
    forecastBasis = read.value;
  }

  let estimateWeight: number | null = null;
  if (raw.estimateWeight !== null && raw.estimateWeight !== undefined) {
    const read = readNumber(raw.estimateWeight, `${path}.estimateWeight`, { min: 0, max: 1 });
    if (!read.ok) return read;
    estimateWeight = read.value;
  }

  if (
    raw.capForecast !== null &&
    raw.capForecast !== undefined &&
    typeof raw.capForecast !== "boolean"
  ) {
    return { ok: false, error: `${path}.capForecast must be true or false.` };
  }

  if (raw.curveEnabled !== undefined && typeof raw.curveEnabled !== "boolean") {
    return { ok: false, error: `${path}.curveEnabled must be true or false.` };
  }

  let curveMode: CurveMode = "ADDITIVE";
  if (raw.curveMode !== undefined) {
    const read = readOneOf(raw.curveMode, CURVE_MODES, `${path}.curveMode`);
    if (!read.ok) return read;
    curveMode = read.value;
  }

  let curveAddend = 0;
  if (raw.curveAddend !== undefined) {
    const read = readNumber(raw.curveAddend, `${path}.curveAddend`);
    if (!read.ok) return read;
    curveAddend = read.value;
  }

  let curveMultiplier = 100;
  if (raw.curveMultiplier !== undefined) {
    const read = readNumber(raw.curveMultiplier, `${path}.curveMultiplier`);
    if (!read.ok) return read;
    curveMultiplier = read.value;
  }

  if (raw.curveExpression !== undefined && typeof raw.curveExpression !== "string") {
    return { ok: false, error: `${path}.curveExpression must be a string.` };
  }
  if (typeof raw.curveExpression === "string" && raw.curveExpression.length > 180) {
    return { ok: false, error: `${path}.curveExpression must be at most 180 characters.` };
  }
  if (raw.curveCap !== undefined && typeof raw.curveCap !== "boolean") {
    return { ok: false, error: `${path}.curveCap must be true or false.` };
  }

  if (!Array.isArray(raw.entries ?? [])) {
    return { ok: false, error: `${path}.entries must be a list.` };
  }
  const entries: GradebookEntry[] = [];
  for (const [i, rawEntry] of ((raw.entries as unknown[]) ?? []).entries()) {
    const entry = parseEntry(rawEntry, `${path}.entries[${i}]`);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }

  return {
    ok: true,
    value: {
      name: raw.name,
      ...(nameColumnWidth === undefined ? {} : { nameColumnWidth }),
      weightMode: mode.value,
      weight: weight.value,
      weightByMax: (raw.weightByMax as boolean) ?? true,
      alphaOverride,
      forecastBasis,
      estimateWeight,
      capForecast: (raw.capForecast as boolean | null) ?? null,
      ...(raw.curveEnabled === undefined ? {} : { curveEnabled: raw.curveEnabled as boolean }),
      ...(raw.curveMode === undefined ? {} : { curveMode }),
      ...(raw.curveAddend === undefined ? {} : { curveAddend }),
      ...(raw.curveMultiplier === undefined ? {} : { curveMultiplier }),
      ...(raw.curveExpression === undefined
        ? {}
        : { curveExpression: raw.curveExpression as string }),
      ...(raw.curveCap === undefined ? {} : { curveCap: raw.curveCap as boolean }),
      entries,
    },
  };
}

/** Whole file or nothing. */
export function parseGradebook(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`That is not valid JSON: ${(e as Error).message}`);
  }

  if (!isRecord(raw)) return fail("A gradebook file must be a JSON object.");

  const version = raw.questlogGradebook;
  if (version === undefined) {
    return fail("This does not look like a Gradebook export: no `questlogGradebook` field.");
  }
  if (version !== GRADEBOOK_FORMAT) {
    return fail(
      `This file is format ${String(version)}; this version of Gradebook reads format ${GRADEBOOK_FORMAT}.`,
    );
  }
  if (!Array.isArray(raw.categories)) return fail("`categories` must be a list.");

  const categories: GradebookCategory[] = [];
  for (const [i, rawCategory] of (raw.categories as unknown[]).entries()) {
    const category = parseCategory(rawCategory, `categories[${i}]`);
    if (!category.ok) return fail(category.error);
    categories.push(category.value);
  }

  // Optional, but validated as strictly as everything else when present -- an
  // import applies it, so a nonsense confidence level must not get through.
  let settings: GradebookFile["settings"];
  if (raw.settings !== undefined && raw.settings !== null) {
    if (!isRecord(raw.settings)) return fail("`settings` must be an object.");

    const alpha = readNumber(raw.settings.alpha, "settings.alpha");
    if (!alpha.ok) return fail(alpha.error);
    if (!(alpha.value > 0 && alpha.value < 1)) {
      return fail("settings.alpha must be between 0 and 1, exclusive.");
    }

    const basis = readOneOf(raw.settings.basis, FORECAST_BASES, "settings.basis");
    if (!basis.ok) return fail(basis.error);

    const estimateWeight = readNumber(raw.settings.estimateWeight, "settings.estimateWeight", {
      min: 0,
      max: 1,
    });
    if (!estimateWeight.ok) return fail(estimateWeight.error);

    const currentWeighting = readOneOf(
      raw.settings.currentWeighting ?? "CATEGORY_PROGRESS",
      CURRENT_GRADE_WEIGHTINGS,
      "settings.currentWeighting",
    );
    if (!currentWeighting.ok) return fail(currentWeighting.error);

    if (
      raw.settings.capForecast !== undefined &&
      typeof raw.settings.capForecast !== "boolean"
    ) {
      return fail("settings.capForecast must be true or false.");
    }

    settings = {
      currentWeighting: currentWeighting.value,
      alpha: alpha.value,
      basis: basis.value,
      estimateWeight: estimateWeight.value,
      // Older files predate the setting; the ceiling was unconditional then.
      capForecast: (raw.settings.capForecast as boolean) ?? true,
    };
  }

  return {
    ok: true,
    value: {
      questlogGradebook: GRADEBOOK_FORMAT,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date(0).toISOString(),
      ...(isRecord(raw.course) && typeof raw.course.name === "string"
        ? { course: { name: raw.course.name, emoji: String(raw.course.emoji ?? "") } }
        : {}),
      ...(settings ? { settings } : {}),
      categories,
    },
  };
}

/** The counterpart, so a file written here reads back here. */
export function serializeGradebook(file: GradebookFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
