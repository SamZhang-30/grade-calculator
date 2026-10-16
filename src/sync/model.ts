import type { AppData, Course, GradeCategoryRow, GradeEntryRow } from "../store";
import type { GpaCourse, GpaTerm } from "../gpa";
import { GPA_GRADES } from "../gpa";
import { CURRENT_GRADE_WEIGHTINGS, CURVE_MODES, FORECAST_BASES, GRADE_STATUSES, WEIGHT_MODES } from "../grade-engine";

export type Value = string | number | boolean | null;
export type RecordData = Record<string, Value>;
export type Records = Record<string, RecordData>;
export interface Conflict {
  key: string;
  label: string;
  field: string;
  local: Value | RecordData | null;
  remote: Value | RecordData | null;
}

export const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) &&
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** Independent documents, not a last-write-wins gradebook snapshot. */
export function toRecords(data: AppData): Records {
  const records: Records = { settings: { ...data.settings } };
  const put = (kind: string, value: object & { id: string }, parent: string | null, order: number,
    omit: string[] = []) => {
    const key = `${kind}:${encodeURIComponent(value.id)}`;
    if (records[key] || key.length > 1400) throw new Error("Sync requires unique, reasonably short record IDs. Export a backup and re-import the affected class.");
    const fields: RecordData = { _parent: parent, _order: order };
    for (const [field, item] of Object.entries(value)) {
      if (omit.includes(field) || item === undefined) continue;
      if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
        throw new Error(`Unsupported sync field: ${field}`);
      }
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Cannot sync non-finite numbers.");
      fields[field] = item as Value;
    }
    records[key] = fields;
    return key;
  };
  data.courses.forEach((course, ci) => {
    const ck = put("course", course, null, ci, ["categories"]);
    course.categories.forEach((category, gi) => {
      const gk = put("category", category, ck, gi, ["entries"]);
      category.entries.forEach((entry, ei) => put("entry", entry, gk, ei));
    });
  });
  data.gpaTerms.forEach((term, ti) => {
    const tk = put("term", term, null, ti, ["courses"]);
    term.courses.forEach((course, ci) => put("gpa-course", course, tk, ci));
  });
  return records;
}

export function fromRecords(records: Records): AppData {
  validateRecords(records);
  if (!records.settings) throw new Error("The cloud gradebook is missing its settings.");
  const children = <T>(kind: string, parent: string | null): (T & { key: string })[] =>
    Object.entries(records).filter(([key, row]) => key.startsWith(`${kind}:`) && row._parent === parent)
      .sort(([ak, a], [bk, b]) => Number(a._order) - Number(b._order) || ak.localeCompare(bk))
      .map(([key, { _parent: _p, _order: _o, ...fields }]) => ({ ...fields, key }) as T & { key: string });
  return {
    version: 1,
    settings: { ...records.settings } as unknown as AppData["settings"],
    courses: children<Course>("course", null).map(({ key, ...course }) => ({ ...course,
      categories: children<GradeCategoryRow>("category", key).map(({ key: gk, ...category }) => ({
        ...category, entries: children<GradeEntryRow>("entry", gk).map(({ key: _key, ...entry }) => entry),
      })),
    })),
    gpaTerms: children<GpaTerm>("term", null).map(({ key, ...term }) => ({ ...term,
      courses: children<GpaCourse>("gpa-course", key).map(({ key: _key, ...course }) => course),
    })),
  };
}

type Check = (value: Value | undefined) => boolean;
const text: Check = (value) => typeof value === "string";
const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
const boolean: Check = (value) => typeof value === "boolean";
const nullable = (check: Check): Check => (value) => value == null || check(value);
const optional = (check: Check): Check => (value) => value === undefined || check(value);
const member = (values: readonly string[]): Check => (value) => typeof value === "string" && values.includes(value);

/** Fail closed on malformed/unsupported cloud data rather than rendering a
 * broken sheet or overwriting a valid local cache. Unknown future fields pause
 * sync until the client is updated. */
export function validateRecords(records: Records) {
  const schemas: Record<string, Record<string, Check>> = {
    settings: { gradeAlpha: number, gradeBasis: member(FORECAST_BASES), gradeIncludeEstimates: boolean,
      gradeCapForecast: boolean, gradeCurrentWeighting: member(CURRENT_GRADE_WEIGHTINGS) },
    course: { id: text, name: text, color: text, emoji: text, term: text, instructor: text, units: text,
      gradeAlpha: nullable(number), gradeBasis: nullable(member(FORECAST_BASES)),
      gradeIncludeEstimates: nullable(boolean), gradeCapForecast: nullable(boolean),
      gradeCurrentWeighting: nullable(member(CURRENT_GRADE_WEIGHTINGS)) },
    category: { id: text, name: text, weightMode: member(WEIGHT_MODES), weight: number, weightByMax: boolean,
      sortOrder: number, nameColumnWidth: number, alphaOverride: nullable(number), forecastBasis: nullable(member(FORECAST_BASES)),
      includeEstimates: nullable(boolean), capForecast: nullable(boolean), estimateWeight: optional(nullable(number)),
      curveEnabled: boolean, curveMode: member(CURVE_MODES), curveAddend: number, curveMultiplier: number,
      curveExpression: text, curveCap: boolean },
    entry: { id: text, name: text, points: nullable(number), max: nullable(number), status: member(GRADE_STATUSES),
      sortOrder: number, notes: nullable(text) },
    term: { id: text, name: text },
    "gpa-course": { id: text, name: text, grade: member(GPA_GRADES), units: nullable(number) },
  };
  if (!records || Array.isArray(records) || !records.settings) throw new Error("Invalid cloud gradebook settings.");
  for (const [key, row] of Object.entries(records)) {
    const kind = key === "settings" ? key : key.split(":")[0]!;
    const fields = schemas[kind];
    if (!fields || !row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).some((field) => !Object.hasOwn(fields, field) && field !== "_parent" && field !== "_order") ||
        Object.entries(fields).some(([field, check]) => !check(row[field]))) {
      throw new Error(`Unsupported cloud record: ${key}. Nothing was overwritten.`);
    }
    if (kind === "settings") continue;
    const parentKind = { course: null, category: "course", entry: "category", term: null, "gpa-course": "term" }[kind];
    if (key !== `${kind}:${encodeURIComponent(String(row.id))}` || !row.id || !number(row._order) ||
        (parentKind === null ? row._parent !== null : typeof row._parent !== "string" ||
          !row._parent.startsWith(`${parentKind}:`) || !records[row._parent])) {
      throw new Error(`Invalid cloud record hierarchy: ${key}. Nothing was overwritten.`);
    }
  }
}

function subtree(records: Records, root: string): Set<string> {
  const keys = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, row] of Object.entries(records)) {
      if (typeof row._parent === "string" && keys.has(row._parent) && !keys.has(key)) {
        keys.add(key); grew = true;
      }
    }
  }
  return keys;
}

/** Three-way, field-level merge. Same-field conflicts require an explicit choice.
 * Deletion versus editing/adding descendants is a subtree conflict, never an orphan.
 */
export function mergeRecords(base: Records, local: Records, remote: Records,
  choice: "local" | "remote" = "local"): { records: Records; conflicts: Conflict[] } {
  const records = structuredClone(remote);
  const conflicts: Conflict[] = [];
  const blocked = new Set<string>();
  const universe = { ...base, ...remote, ...local };
  const report = (key: string, field: string, mine: Conflict["local"], theirs: Conflict["remote"]) => {
    conflicts.push({ key, field, label: String(local[key]?.name ?? remote[key]?.name ?? base[key]?.name ?? key),
      local: mine, remote: theirs });
  };
  // Protect a whole branch when one side deletes it while the other changes it.
  for (const key of Object.keys(base)) {
    if (blocked.has(key) || (!!local[key] === !!remote[key])) continue;
    const surviving = local[key] ? local : remote;
    const branch = subtree(universe, key);
    if (![...branch].some((child) => !same(base[child], surviving[child]))) continue;
    report(key, "record and children", local[key] ?? null, remote[key] ?? null);
    const selected = choice === "local" ? local : remote;
    for (const child of branch) {
      blocked.add(child);
      delete records[child];
      if (selected[child]) records[child] = structuredClone(selected[child]);
    }
  }
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (blocked.has(key)) continue;
    const before = base[key], mine = local[key], theirs = remote[key];
    if (same(before, mine) || same(mine, theirs)) continue;
    if (!before || !mine || !theirs) {
      if (!same(before, theirs)) {
        report(key, "record", mine ?? null, theirs ?? null);
        if (choice === "remote") continue;
      }
      if (mine) records[key] = structuredClone(mine);
      else delete records[key];
      continue;
    }
    for (const field of new Set([...Object.keys(before), ...Object.keys(mine)])) {
      if (same(before[field], mine[field]) || same(mine[field], theirs[field])) continue;
      if (!same(before[field], theirs[field])) {
        report(key, field, mine[field] ?? null, theirs[field] ?? null);
        if (choice === "remote") continue;
      }
      if (Object.hasOwn(mine, field)) records[key]![field] = mine[field]!;
      else delete records[key]![field];
    }
  }
  return { records, conflicts };
}

export function changedKeys(before: Records, after: Records): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !same(before[key], after[key]));
}
