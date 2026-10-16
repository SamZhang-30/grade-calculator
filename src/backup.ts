import type { AppData } from "./store";
import { fromRecords, same, toRecords } from "./sync/model";
import { normalizeGpaTerms } from "./gpa";

export const BACKUP_FORMAT = "gradebook-full-backup";
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** Round-trip validation rejects unknown fields instead of silently discarding
 * data from newer clients. No account credentials, caches, or undo stacks. */
export function validateAppData(value: unknown): AppData {
  try {
    if (!value || typeof value !== "object" || (value as AppData).version !== 1) throw new Error();
    const data = fromRecords(toRecords(value as AppData));
    if (!same(data, value) || !same(normalizeGpaTerms(data.gpaTerms), data.gpaTerms)) throw new Error();
    return data;
  } catch {
    throw new Error("This is not a supported whole-app backup. Nothing was replaced. Use a backup exported by Backups & data, not a single-course export.");
  }
}

export function serializeBackup(data: AppData, now = new Date()): string {
  const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), data: validateAppData(data) }, null, 2);
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error("This gradebook exceeds the 10 MB whole-app backup limit. Export individual courses instead.");
  return text;
}

export function parseBackup(text: string): { data: AppData; exportedAt: string } {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error("Backups must be smaller than 10 MB.");
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error("This file is not valid JSON. Nothing was replaced."); }
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== 1 ||
      Object.keys(backup).some((key) => !["format", "version", "exportedAt", "data"].includes(key)) ||
      typeof backup.exportedAt !== "string" || !Number.isFinite(Date.parse(backup.exportedAt))) {
    throw new Error("Choose a supported whole-app backup from Backups & data. Nothing was replaced.");
  }
  return { data: validateAppData(backup.data), exportedAt: backup.exportedAt };
}

export function backupCounts(data: AppData): string {
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return [`${data.courses.length} ${data.courses.length === 1 ? "class" : "classes"}`,
    plural(data.courses.flatMap((course) => course.categories).flatMap((category) => category.entries).length, "assignment"),
    plural(data.gpaTerms.length, "GPA term"),
    plural(data.gpaTerms.flatMap((term) => term.courses).length, "GPA course")].join(" · ");
}
