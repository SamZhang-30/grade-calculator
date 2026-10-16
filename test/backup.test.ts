import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, backupCounts, MAX_BACKUP_BYTES, parseBackup, serializeBackup, validateAppData } from "../src/backup";
import { loadData } from "../src/store";
import { calculateGpa } from "../src/gpa";

const fixture = () => {
  const data = loadData();
  data.gpaTerms = [{ id: "term-backup", name: "Autumn", courses: [
    { id: "gpa-backup", name: "MATH 51", grade: "A-", units: 0 },
  ] }];
  return data;
};

describe("whole-app backups", () => {
  it("round-trips all settings, course fields, notes, curves and GPA terms", () => {
    const data = fixture();
    data.courses[0]!.categories[0]!.entries[0]!.notes = "Private notes <script>not executable</script>";
    data.courses[0]!.categories[0]!.curveEnabled = true;
    data.settings.gradeAlpha = .12;
    const backup = serializeBackup(data, new Date("2026-10-16T12:00:00Z"));
    expect(parseBackup(backup)).toEqual({ data, exportedAt: "2026-10-16T12:00:00.000Z" });
    expect(Object.keys(JSON.parse(backup))).toEqual(["format", "version", "exportedAt", "data"]);
    expect(backupCounts(data)).toContain("1 class");
    expect(backupCounts(data)).toContain("1 GPA term · 1 GPA course");
  });
  it("supports empty gradebooks and correct plurals", () => {
    const data = fixture(); data.courses = []; data.gpaTerms = [];
    expect(parseBackup(serializeBackup(data)).data).toEqual(data);
    expect(backupCounts(data)).toBe("0 classes · 0 assignments · 0 GPA terms · 0 GPA courses");
  });
  it("preserves visible legacy fractional units without counting them toward GPA", () => {
    const data = fixture(); data.gpaTerms[0]!.courses[0]!.units = 2.5;
    const restored = parseBackup(serializeBackup(data)).data;
    expect(restored).toEqual(data);
    expect(calculateGpa(restored.gpaTerms[0]!.courses).gpa).toBeNull();
  });
  it.each([
    (data: any) => { data.version = 2; },
    (data: any) => { data.authToken = "never import credentials"; },
    (data: any) => { delete data.courses; },
    (data: any) => { data.courses[0].categories = null; },
    (data: any) => { data.courses.push(structuredClone(data.courses[0])); },
    (data: any) => { data.courses[0].categories[0].entries[0].status = "UNKNOWN"; },
    (data: any) => { data.settings.gradeAlpha = Infinity; },
    (data: any) => { data.gpaTerms[0].courses[0].units = -1; },
    (data: any) => { data.gpaTerms[0].courses[0].id = data.gpaTerms[0].id; },
    (data: any) => { data.gpaTerms[0].courses[0].grade = "A++"; },
  ])("fails closed on malformed, future or invalid data (%#)", (damage) => {
    const data = fixture(); damage(data);
    expect(() => validateAppData(data)).toThrow("Nothing was replaced");
  });
  it("rejects wrong envelopes, invalid dates, malformed JSON and oversized files", () => {
    expect(() => parseBackup("{" )).toThrow("valid JSON");
    expect(() => parseBackup(JSON.stringify(fixture()))).toThrow("whole-app backup");
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: "no date", data: fixture() }))).toThrow("Nothing was replaced");
    expect(() => parseBackup(" ".repeat(MAX_BACKUP_BYTES + 1))).toThrow("10 MB");
    const data = fixture(); data.courses[0]!.name = "x".repeat(MAX_BACKUP_BYTES);
    expect(() => serializeBackup(data)).toThrow("10 MB");
  });
});
