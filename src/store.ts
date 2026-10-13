import {
  CURRENT_GRADE_WEIGHTINGS,
  CURVE_MODES,
  DEFAULT_GRADE_CONFIG,
  parseGradebook,
  type CurveMode,
  type CurrentGradeWeighting,
  type ForecastBasis,
  type GradeCategory,
  type GradeEntry,
  type GradeStatus,
  type WeightMode,
} from "./grade-engine";
import { GPA_GRADES, normalizeGpaTerms, validGpaUnits, type GpaTerm, type GpaCourse } from "./gpa";

/** The engine's shapes plus the editable fields the interface stores. */
export interface GradeEntryRow extends GradeEntry {
  notes: string | null;
}

export type GradeEntryPatch = Partial<
  Pick<GradeEntryRow, "name" | "points" | "max" | "status" | "notes">
>;

export interface GradeCategoryRow extends GradeCategory {
  entries: GradeEntryRow[];
  nameColumnWidth: number;
  alphaOverride: number | null;
  forecastBasis: ForecastBasis | null;
  includeEstimates: boolean | null;
  capForecast: boolean | null;
  curveEnabled: boolean;
  curveMode: CurveMode;
  curveAddend: number;
  curveMultiplier: number;
  curveExpression: string;
  curveCap: boolean;
}

export interface Course {
  id: string;
  name: string;
  color: string;
  emoji: string;
  term: string;
  instructor: string;
  units: string;
  gradeAlpha: number | null;
  gradeBasis: ForecastBasis | null;
  gradeIncludeEstimates: boolean | null;
  gradeCapForecast: boolean | null;
  gradeCurrentWeighting: CurrentGradeWeighting | null;
  categories: GradeCategoryRow[];
}

export interface AppSettings {
  gradeAlpha: number;
  gradeBasis: ForecastBasis;
  gradeIncludeEstimates: boolean;
  gradeCapForecast: boolean;
  gradeCurrentWeighting: CurrentGradeWeighting;
}

export interface AppData {
  version: 1;
  settings: AppSettings;
  courses: Course[];
  gpaTerms: GpaTerm[];
}

const STORAGE_KEY = "gradebook.data.v1";

const uid = (prefix: string) =>
  `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const starterData = (): AppData => ({
  version: 1,
  gpaTerms: [],
  settings: {
    gradeAlpha: DEFAULT_GRADE_CONFIG.alpha,
    gradeBasis: DEFAULT_GRADE_CONFIG.defaultBasis,
    gradeIncludeEstimates: DEFAULT_GRADE_CONFIG.estimateWeight > 0,
    gradeCapForecast: DEFAULT_GRADE_CONFIG.capForecastAtFull,
    gradeCurrentWeighting: DEFAULT_GRADE_CONFIG.currentGradeWeighting,
  },
  courses: [
    {
      id: "sample-course",
      name: "Example course",
      color: "#8b7cf6",
      emoji: "📚",
      term: "Fall 2026",
      instructor: "Professor",
      units: "4 units",
      gradeAlpha: null,
      gradeBasis: null,
      gradeIncludeEstimates: null,
      gradeCapForecast: null,
      gradeCurrentWeighting: null,
      categories: [
        {
          id: "sample-coursework",
          name: "Coursework",
          weightMode: "FIXED",
          weight: 0.55,
          weightByMax: true,
          nameColumnWidth: 180,
          alphaOverride: null,
          forecastBasis: null,
          includeEstimates: null,
          capForecast: null,
          curveEnabled: false,
          curveMode: "ADDITIVE",
          curveAddend: 0,
          curveMultiplier: 100,
          curveExpression: "x",
          curveCap: true,
          sortOrder: 0,
          entries: [
            {
              id: "sample-assignment-1",
              name: "Assignment 1",
              points: 92,
              max: 100,
              status: "RETURNED",
              notes: "",
              sortOrder: 0,
            },
            {
              id: "sample-assignment-2",
              name: "Assignment 2",
              points: 87,
              max: 100,
              status: "RETURNED",
              notes: "",
              sortOrder: 1,
            },
            {
              id: "sample-assignment-3",
              name: "Assignment 3",
              points: null,
              max: 100,
              status: "PENDING",
              notes: "",
              sortOrder: 2,
            },
          ],
        },
        {
          id: "sample-final",
          name: "Final exam",
          weightMode: "FIXED",
          weight: 0.45,
          weightByMax: true,
          nameColumnWidth: 180,
          alphaOverride: null,
          forecastBasis: null,
          includeEstimates: null,
          capForecast: null,
          curveEnabled: false,
          curveMode: "ADDITIVE",
          curveAddend: 0,
          curveMultiplier: 100,
          curveExpression: "x",
          curveCap: true,
          sortOrder: 1,
          entries: [
            {
              id: "sample-final-entry",
              name: "Final exam",
              points: null,
              max: 100,
              status: "PENDING",
              notes: "",
              sortOrder: 0,
            },
          ],
        },
      ],
    },
  ],
});

let inMemory = starterData();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadData(): AppData {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(inMemory);
  try {
    const parsed = JSON.parse(raw) as AppData;
    if (parsed.version !== 1 || !Array.isArray(parsed.courses)) throw new Error("Unsupported data");
    parsed.gpaTerms = normalizeGpaTerms(parsed.gpaTerms);
    // Metadata was added after the first release. Normalizing on read keeps
    // existing local gradebooks valid without a disruptive storage migration.
    parsed.settings = {
      ...parsed.settings,
      gradeCurrentWeighting: CURRENT_GRADE_WEIGHTINGS.includes(
        parsed.settings?.gradeCurrentWeighting as CurrentGradeWeighting,
      )
        ? (parsed.settings.gradeCurrentWeighting as CurrentGradeWeighting)
        : DEFAULT_GRADE_CONFIG.currentGradeWeighting,
    };
    parsed.courses = parsed.courses.map((course) => ({
      ...course,
      gradeCurrentWeighting: CURRENT_GRADE_WEIGHTINGS.includes(
        course.gradeCurrentWeighting as CurrentGradeWeighting,
      )
        ? (course.gradeCurrentWeighting as CurrentGradeWeighting)
        : null,
      emoji: typeof course.emoji === "string" && course.emoji ? course.emoji : "📚",
      term: typeof course.term === "string" ? course.term : "",
      instructor: typeof course.instructor === "string" ? course.instructor : "",
      units: typeof course.units === "string" ? course.units : "",
      categories: course.categories.map((category) => ({
        ...category,
        nameColumnWidth:
          typeof category.nameColumnWidth === "number" && Number.isFinite(category.nameColumnWidth)
            ? Math.min(420, Math.max(80, Math.round(category.nameColumnWidth)))
            : 180,
        curveEnabled: category.curveEnabled === true,
        curveMode: CURVE_MODES.includes(category.curveMode as CurveMode)
          ? (category.curveMode as CurveMode)
          : "ADDITIVE",
        curveAddend:
          typeof category.curveAddend === "number" && Number.isFinite(category.curveAddend)
            ? category.curveAddend
            : 0,
        curveMultiplier:
          typeof category.curveMultiplier === "number" && Number.isFinite(category.curveMultiplier)
            ? category.curveMultiplier
            : 100,
        curveExpression:
          typeof category.curveExpression === "string" ? category.curveExpression : "x",
        curveCap: typeof category.curveCap === "boolean" ? category.curveCap : true,
      })),
    }));
    inMemory = parsed;
    return structuredClone(parsed);
  } catch {
    return structuredClone(inMemory);
  }
}

function saveData(data: AppData) {
  const target = storage();
  if (target) {
    try {
      target.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new Error("Your browser could not save this change. Check local storage permissions.");
    }
  }
  inMemory = data;
}

type HistoryStep = { before: string; after: string };
const undoSteps: HistoryStep[] = [];
const redoSteps: HistoryStep[] = [];
const historyListeners = new Set<() => void>();
let historyCurrent: string | null = null;
const notifyHistory = () => historyListeners.forEach((listener) => listener());

function syncHistory(current: string) {
  // A different tab or an external restore must not be overwritten by an old
  // undo stack. History covers this editing session, not browser reloads.
  if (historyCurrent !== null && current !== historyCurrent) {
    undoSteps.length = 0;
    redoSteps.length = 0;
  }
  historyCurrent = current;
}

function restoreHistory(direction: "undo" | "redo"): AppData | null {
  syncHistory(JSON.stringify(loadData()));
  const from = direction === "undo" ? undoSteps : redoSteps;
  const to = direction === "undo" ? redoSteps : undoSteps;
  const step = from.at(-1);
  if (!step) { notifyHistory(); return null; }
  const snapshot = direction === "undo" ? step.before : step.after;
  const restored = JSON.parse(snapshot) as AppData;
  saveData(restored);
  from.pop();
  to.push(step);
  historyCurrent = snapshot;
  notifyHistory();
  return structuredClone(restored);
}

function mutate<T>(fn: (data: AppData) => T): Promise<T> {
  const data = loadData();
  const before = JSON.stringify(data);
  syncHistory(before);
  const result = fn(data);
  const after = JSON.stringify(data);
  if (after === before) return Promise.resolve(result);
  saveData(data);
  undoSteps.push({ before, after });
  if (undoSteps.length > 100) undoSteps.shift();
  redoSteps.length = 0;
  historyCurrent = after;
  notifyHistory();
  return Promise.resolve(result);
}

function courseById(data: AppData, id: string): Course {
  const course = data.courses.find((candidate) => candidate.id === id);
  if (!course) throw new Error("That class no longer exists.");
  return course;
}

function categoryById(data: AppData, id: string): GradeCategoryRow {
  const category = data.courses.flatMap((course) => course.categories).find((item) => item.id === id);
  if (!category) throw new Error("That category no longer exists.");
  return category;
}

function entryById(data: AppData, id: string): GradeEntryRow {
  const entry = data.courses
    .flatMap((course) => course.categories)
    .flatMap((category) => category.entries)
    .find((item) => item.id === id);
  if (!entry) throw new Error("That assignment no longer exists.");
  return entry;
}

function gpaTermById(data: AppData, id: string): GpaTerm {
  const term = data.gpaTerms.find((item) => item.id === id);
  if (!term) throw new Error("That term no longer exists.");
  return term;
}

function gpaCourseById(data: AppData, id: string): GpaCourse {
  const course = data.gpaTerms.flatMap((term) => term.courses).find((item) => item.id === id);
  if (!course) throw new Error("That GPA course no longer exists.");
  return course;
}

export const store = {
  addGpaTerm: (name: string) => mutate((data) => {
    const term: GpaTerm = { id: uid("gpa-term"), name: name.trim() || "Untitled term",
      courses: [{ id: uid("gpa-course"), name: "", grade: "", units: null }] };
    data.gpaTerms.push(term);
    return term;
  }),
  renameGpaTerm: (id: string, name: string) => mutate((data) => {
    if (!name.trim()) throw new Error("Enter a term name.");
    gpaTermById(data, id).name = name.trim();
  }),
  deleteGpaTerm: (id: string) => mutate((data) => {
    data.gpaTerms = data.gpaTerms.filter((term) => term.id !== id);
  }),
  addGpaCourse: (termId: string) => mutate((data) => {
    const course: GpaCourse = { id: uid("gpa-course"), name: "", grade: "", units: null };
    gpaTermById(data, termId).courses.push(course);
    return course;
  }),
  updateGpaCourse: (id: string, patch: Partial<Pick<GpaCourse, "name" | "grade" | "units">>) => mutate((data) => {
    if (patch.grade !== undefined && !GPA_GRADES.includes(patch.grade)) throw new Error("Choose a Stanford grade.");
    if (patch.units !== undefined && patch.units !== null && !validGpaUnits(patch.units)) {
      throw new Error("Units must be a whole number (0 or more), or blank.");
    }
    Object.assign(gpaCourseById(data, id), patch);
  }),
  duplicateGpaCourse: (id: string) => mutate((data) => {
    const term = data.gpaTerms.find((item) => item.courses.some((course) => course.id === id));
    if (!term) throw new Error("That GPA course no longer exists.");
    const index = term.courses.findIndex((course) => course.id === id);
    const copy = { ...term.courses[index]!, id: uid("gpa-course") };
    term.courses.splice(index + 1, 0, copy);
    return copy;
  }),
  deleteGpaCourse: (id: string) => mutate((data) => {
    for (const term of data.gpaTerms) term.courses = term.courses.filter((course) => course.id !== id);
  }),
  undo: () => restoreHistory("undo"),
  redo: () => restoreHistory("redo"),
  historyState: () => ({ canUndo: undoSteps.length > 0, canRedo: redoSteps.length > 0 }),
  subscribeHistory: (listener: () => void) => {
    historyListeners.add(listener);
    return () => { historyListeners.delete(listener); };
  },
  clearHistory: () => {
    undoSteps.length = 0;
    redoSteps.length = 0;
    historyCurrent = null;
    notifyHistory();
  },
  reorderCourses: (ids: string[]) =>
    mutate((data) => {
      const byId = new Map(data.courses.map((course) => [course.id, course]));
      if (ids.length !== data.courses.length || new Set(ids).size !== ids.length ||
          ids.some((id) => !byId.has(id))) {
        throw new Error("The class list changed. Try reordering it again.");
      }
      data.courses = ids.map((id) => byId.get(id)!);
    }),

  createCourse: (name: string, color: string) =>
    mutate((data) => {
      const course: Course = {
        id: uid("course"),
        name: name.trim() || "Untitled class",
        color,
        emoji: "📚",
        term: "",
        instructor: "",
        units: "",
        gradeAlpha: null,
        gradeBasis: null,
        gradeIncludeEstimates: null,
        gradeCapForecast: null,
        gradeCurrentWeighting: null,
        categories: [],
      };
      data.courses.push(course);
      return course;
    }),

  updateCourse: (
    id: string,
    patch: Partial<Pick<Course, "name" | "color" | "emoji" | "term" | "instructor" | "units">>,
  ) =>
    mutate((data) => Object.assign(courseById(data, id), patch)),

  deleteCourse: (id: string) =>
    mutate((data) => {
      data.courses = data.courses.filter((course) => course.id !== id);
    }),

  updateSettings: (patch: Partial<AppSettings>) =>
    mutate((data) => Object.assign(data.settings, patch)),
};

/**
 * A small compatibility facade for the extracted GradeSheet. All writes are
 * synchronous local-storage transactions, wrapped in promises so the original
 * component keeps its commit/error behavior.
 */
export const api = {
  updateItem: (
    id: string,
    patch: {
      gradeAlpha?: number | null;
      gradeBasis?: ForecastBasis | null;
      gradeIncludeEstimates?: boolean | null;
      gradeCapForecast?: boolean | null;
      gradeCurrentWeighting?: CurrentGradeWeighting | null;
    },
  ) => mutate((data) => Object.assign(courseById(data, id), patch)),

  addGradeCategory: (
    courseId: string,
    body: { name: string; weight?: number; weightMode?: WeightMode; weightByMax?: boolean },
  ) =>
    mutate((data) => {
      const course = courseById(data, courseId);
      const category: GradeCategoryRow = {
        id: uid("category"),
        name: body.name,
        weightMode: body.weightMode ?? "FIXED",
        weight: body.weight ?? 0,
        weightByMax: body.weightByMax ?? true,
        nameColumnWidth: 180,
        alphaOverride: null,
        forecastBasis: null,
        includeEstimates: null,
        capForecast: null,
        curveEnabled: false,
        curveMode: "ADDITIVE",
        curveAddend: 0,
        curveMultiplier: 100,
        curveExpression: "x",
        curveCap: true,
        sortOrder: course.categories.length,
        entries: [],
      };
      course.categories.push(category);
      return category;
    }),

  updateGradeCategory: (
    id: string,
    patch: {
      name?: string;
      weight?: number;
      weightMode?: WeightMode;
      weightByMax?: boolean;
      nameColumnWidth?: number;
      alphaOverride?: number | null;
      forecastBasis?: ForecastBasis | null;
      includeEstimates?: boolean | null;
      capForecast?: boolean | null;
      curveEnabled?: boolean;
      curveMode?: CurveMode;
      curveAddend?: number;
      curveMultiplier?: number;
      curveExpression?: string;
      curveCap?: boolean;
    },
  ) => mutate((data) => Object.assign(categoryById(data, id), patch)),

  deleteGradeCategory: (id: string) =>
    mutate((data) => {
      for (const course of data.courses) {
        const next = course.categories.filter((category) => category.id !== id);
        if (next.length !== course.categories.length) {
          course.categories = next.map((category, index) => ({ ...category, sortOrder: index }));
          return;
        }
      }
    }),

  addGradeEntry: (
    categoryId: string,
    body: {
      name: string;
      points?: number | null;
      max?: number | null;
      status?: GradeStatus;
      notes?: string;
    },
  ) =>
    mutate((data) => {
      const category = categoryById(data, categoryId);
      const entry: GradeEntryRow = {
        id: uid("entry"),
        name: body.name,
        points: body.points ?? null,
        max: body.max ?? null,
        status: body.status ?? "PENDING",
        notes: body.notes ?? null,
        sortOrder: category.entries.length,
      };
      category.entries.push(entry);
      return entry;
    }),

  updateGradeEntry: (id: string, patch: GradeEntryPatch) =>
    mutate((data) => Object.assign(entryById(data, id), patch)),

  duplicateGradeEntry: (id: string) =>
    mutate((data) => {
      for (const category of data.courses.flatMap((course) => course.categories)) {
        const index = category.entries.findIndex((entry) => entry.id === id);
        if (index < 0) continue;
        const duplicate = { ...category.entries[index]!, id: uid("entry") };
        category.entries.splice(index + 1, 0, duplicate);
        category.entries.forEach((entry, sortOrder) => { entry.sortOrder = sortOrder; });
        return duplicate;
      }
      throw new Error("That assignment no longer exists.");
    }),

  updateGradeEntries: (updates: { id: string; patch: GradeEntryPatch }[]) =>
    mutate((data) => {
      for (const update of updates) Object.assign(entryById(data, update.id), update.patch);
    }),

  deleteGradeEntry: (id: string) =>
    mutate((data) => {
      for (const category of data.courses.flatMap((course) => course.categories)) {
        const next = category.entries.filter((entry) => entry.id !== id);
        if (next.length !== category.entries.length) {
          category.entries = next.map((entry, index) => ({ ...entry, sortOrder: index }));
          return;
        }
      }
    }),

  reorderGrades: (courseId: string, order: { id: string; entryIds: string[] }[]) =>
    mutate((data) => {
      const course = courseById(data, courseId);
      const allEntries = new Map(course.categories.flatMap((category) => category.entries).map((entry) => [entry.id, entry]));
      for (const requested of order) {
        const category = course.categories.find((candidate) => candidate.id === requested.id);
        if (!category) continue;
        category.entries = requested.entryIds.flatMap((id, index) => {
          const entry = allEntries.get(id);
          return entry ? [{ ...entry, sortOrder: index }] : [];
        });
      }
    }),

  importGradebook: (courseId: string, text: string) =>
    mutate((data) => {
      const parsed = parseGradebook(text);
      if (!parsed.ok) throw new Error(parsed.error);
      const course = courseById(data, courseId);
      const { categories, settings } = parsed.value;

      if (settings) {
        course.gradeAlpha = settings.alpha;
        course.gradeBasis = settings.basis;
        course.gradeIncludeEstimates = settings.estimateWeight > 0;
        course.gradeCapForecast = settings.capForecast;
        course.gradeCurrentWeighting = settings.currentWeighting;
      }

      course.categories = categories.map((category, categoryIndex) => ({
        id: uid("category"),
        name: category.name,
        nameColumnWidth: category.nameColumnWidth ?? 180,
        weightMode: category.weightMode,
        weight: category.weight,
        weightByMax: category.weightByMax,
        alphaOverride: category.alphaOverride,
        forecastBasis: category.forecastBasis,
        includeEstimates:
          category.estimateWeight === null ? null : category.estimateWeight > 0,
        capForecast: category.capForecast,
        curveEnabled: category.curveEnabled ?? false,
        curveMode: category.curveMode ?? "ADDITIVE",
        curveAddend: category.curveAddend ?? 0,
        curveMultiplier: category.curveMultiplier ?? 100,
        curveExpression: category.curveExpression ?? "x",
        curveCap: category.curveCap ?? true,
        sortOrder: categoryIndex,
        entries: category.entries.map((entry, entryIndex) => ({
          id: uid("entry"),
          name: entry.name,
          points: entry.points,
          max: entry.max,
          status: entry.status,
          notes: entry.notes,
          sortOrder: entryIndex,
        })),
      }));

      return {
        categories: categories.length,
        entries: categories.reduce((total, category) => total + category.entries.length, 0),
        settingsApplied: settings !== undefined,
      };
    }),
};
