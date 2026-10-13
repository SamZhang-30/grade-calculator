/** Stanford General University GPA rules (current scale, Autumn 2014 onward).
 * Source: https://studentservices.stanford.edu/my-academics/evaluations-exams-grades/grades/how-do-i-calculate-my-grade-point-average-gpa
 * GSB conversions apply to non-MBA/non-MSx students only. RP must be entered
 * as shown on the transcript; do not infer repeat eligibility from names.
 */
export const GPA_POINTS = {
  "A+": 4.3, A: 4, "A-": 3.7,
  "B+": 3.3, B: 3, "B-": 2.7,
  "C+": 2.3, C: 2, "C-": 1.7,
  "D+": 1.3, D: 1, "D-": 0.7,
  NP: 0, L: 2,
  "GSB:H": 4.14, "GSB:HP": 3.54, "GSB:P": 3.24, "GSB:LP": 2.94, "GSB:U": 0,
} as const;

export const GPA_EXCLUDED = ["CR", "S", "NC", "W", "I", "GNR", "RP", "N", "N-", "G", "+", "*"] as const;
export type GpaGrade = keyof typeof GPA_POINTS | typeof GPA_EXCLUDED[number] | "";
export const GPA_GRADES: readonly string[] = [...Object.keys(GPA_POINTS), ...GPA_EXCLUDED, ""];
export const GPA_SOURCE = "https://studentservices.stanford.edu/my-academics/evaluations-exams-grades/grades/how-do-i-calculate-my-grade-point-average-gpa";
export const formatGpa = (value: number | null) => value === null ? "N/A" : value.toFixed(4);

export interface GpaCourse {
  id: string;
  name: string;
  grade: GpaGrade;
  units: number | null;
}
export interface GpaTerm {
  id: string;
  name: string;
  courses: GpaCourse[];
}

export const validGpaUnits = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Blank is unset; undefined marks invalid input without discarding a draft. */
export function parseGpaUnits(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return validGpaUnits(value) ? value : undefined;
}

/** Total entered coursework, including grades excluded from the GPA. */
export function totalCoursework(courses: readonly GpaCourse[]) {
  let units = 0;
  let courseCount = 0;
  for (const course of courses) {
    if (validGpaUnits(course.units)) {
      units += course.units;
      courseCount++;
    }
  }
  return { units, courseCount };
}

export function gradePoints(grade: string): number | null {
  return Object.hasOwn(GPA_POINTS, grade) ? GPA_POINTS[grade as keyof typeof GPA_POINTS] : null;
}
export function gpaCourseResult(course: GpaCourse) {
  const points = gradePoints(course.grade);
  const validUnits = validGpaUnits(course.units);
  const counted = points !== null && validUnits;
  return { points, counted, units: counted ? course.units! : 0,
    qualityPoints: counted ? points! * course.units! : 0 };
}
export function calculateGpa(courses: readonly GpaCourse[]) {
  let units = 0;
  let qualityPoints = 0;
  let countedCourses = 0;
  for (const course of courses) {
    const result = gpaCourseResult(course);
    units += result.units;
    qualityPoints += result.qualityPoints;
    if (result.counted) countedCourses++;
  }
  return { units, qualityPoints, countedCourses, gpa: units > 0 ? qualityPoints / units : null };
}

/** Backward-compatible storage normalization. Invalid values stay uncounted. */
export function normalizeGpaTerms(value: unknown): GpaTerm[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((term) => {
    if (!term || typeof term.id !== "string" || ids.has(term.id) || !Array.isArray(term.courses)) return [];
    ids.add(term.id);
    const courses: GpaCourse[] = term.courses.flatMap((course: GpaCourse) => {
      if (!course || typeof course.id !== "string" || ids.has(course.id)) return [];
      ids.add(course.id);
      return [{ id: course.id, name: typeof course.name === "string" ? course.name : "",
        grade: GPA_GRADES.includes(course.grade) ? course.grade : "",
        // Keep previously accepted fractional values visible for correction,
        // rather than silently erasing or rounding them. Calculations exclude
        // them under the whole-unit rule, and the input flags them as invalid.
        units: typeof course.units === "number" && Number.isFinite(course.units) && course.units >= 0 ? course.units : null }];
    });
    return [{ id: term.id, name: typeof term.name === "string" ? term.name : "Untitled term", courses }];
  });
}
