import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, loadData, store } from "../src/store";

const initial = loadData();

beforeEach(() => {
  store.clearHistory();
  const values = new Map([["gradebook.data.v1", JSON.stringify(initial)]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  });
});

describe("undo and redo", () => {
  it("persists GPA terms and restores all GPA edits, duplicates and deletions", async () => {
    const states = [loadData()];
    const term = await store.addGpaTerm("Autumn 2026");
    states.push(loadData());
    await store.updateGpaCourse(term.courses[0]!.id, { name: "MATH 51", grade: "A+", units: 5 });
    states.push(loadData());
    const copy = await store.duplicateGpaCourse(term.courses[0]!.id);
    expect(copy).toMatchObject({ name: "MATH 51", grade: "A+", units: 5 });
    expect(copy.id).not.toBe(term.courses[0]!.id);
    states.push(loadData());
    await store.renameGpaTerm(term.id, "Winter 2027");
    states.push(loadData());
    await store.deleteGpaCourse(copy.id);
    states.push(loadData());
    await store.addGpaCourse(term.id);
    states.push(loadData());
    await store.deleteGpaTerm(term.id);
    states.push(loadData());
    for (let index = states.length - 2; index >= 0; index--) expect(store.undo()).toEqual(states[index]);
    for (let index = 1; index < states.length; index++) expect(store.redo()).toEqual(states[index]);
    expect(loadData().courses).toEqual(states[0]!.courses);
  });
  it("loads old gradebooks with empty GPA terms and rejects invalid GPA units", async () => {
    const old = { ...loadData() } as Partial<ReturnType<typeof loadData>>;
    delete old.gpaTerms;
    window.localStorage.setItem("gradebook.data.v1", JSON.stringify(old));
    expect(loadData().gpaTerms).toEqual([]);
    const term = await store.addGpaTerm("Term");
    const before = loadData();
    expect(() => store.updateGpaCourse(term.courses[0]!.id, { units: -1 })).toThrow("whole number");
    expect(() => store.updateGpaCourse(term.courses[0]!.id, { units: 1.5 })).toThrow("whole number");
    expect(loadData()).toEqual(before);
  });
  it("persists zero-unit GPA courses and supports undo/redo of zero-unit edits", async () => {
    const term = await store.addGpaTerm("Term");
    await store.updateGpaCourse(term.courses[0]!.id, { grade: "A", units: 5 });
    await store.updateGpaCourse(term.courses[0]!.id, { units: 0 });
    expect(loadData().gpaTerms[0]!.courses[0]!.units).toBe(0);
    expect(store.undo()!.gpaTerms[0]!.courses[0]!.units).toBe(5);
    expect(store.redo()!.gpaTerms[0]!.courses[0]!.units).toBe(0);
  });
  it("restores category deletion and gradebook import atomically", async () => {
    const before = loadData();
    const course = before.courses[0]!;
    await api.deleteGradeCategory(course.categories[0]!.id);
    expect(store.undo()).toEqual(before);
    await api.importGradebook(course.id, JSON.stringify({
      questlogGradebook: 1,
      categories: [{ name: "Replacement", weight: 1, entries: [
        { name: "Imported", points: 8, max: 10, status: "RETURNED" },
      ] }],
    }));
    const imported = loadData();
    expect(imported.courses[0]!.categories[0]!.name).toBe("Replacement");
    expect(store.undo()).toEqual(before);
    expect(store.redo()).toEqual(imported);
  });

  it("undoes assignment reordering and discards stale history after an external edit", async () => {
    const before = loadData();
    const course = before.courses[0]!;
    await api.reorderGrades(course.id, course.categories.map((category) => ({
      id: category.id, entryIds: category.entries.map((entry) => entry.id).reverse(),
    })));
    expect(store.undo()).toEqual(before);
    store.redo();
    const external = loadData();
    external.courses[0]!.name = "Changed in another tab";
    window.localStorage.setItem("gradebook.data.v1", JSON.stringify(external));
    expect(store.undo()).toBeNull();
    expect(loadData()).toEqual(external);
    expect(store.historyState()).toEqual({ canUndo: false, canRedo: false });
  });

  it("restores duplicates, edits, deletions, settings, and course reorders in sequence", async () => {
    const states = [loadData()];
    const entry = states[0]!.courses[0]!.categories[0]!.entries[0]!;
    await api.duplicateGradeEntry(entry.id);
    states.push(loadData());
    await api.updateGradeEntry(entry.id, { points: 12 });
    states.push(loadData());
    await api.deleteGradeEntry(entry.id);
    states.push(loadData());
    await store.updateSettings({ gradeCurrentWeighting: "CATEGORY_PROGRESS" });
    states.push(loadData());
    await store.createCourse("Other", "#123456");
    states.push(loadData());
    await store.reorderCourses(loadData().courses.map((course) => course.id).reverse());
    states.push(loadData());
    await store.deleteCourse(loadData().courses[0]!.id);
    states.push(loadData());
    for (let i = states.length - 2; i >= 0; i--) expect(store.undo()).toEqual(states[i]);
    expect(store.historyState()).toEqual({ canUndo: false, canRedo: true });
    for (let i = 1; i < states.length; i++) expect(store.redo()).toEqual(states[i]);
    expect(store.historyState()).toEqual({ canUndo: true, canRedo: false });
  });

  it("treats autofill updates as one step and retains redo across no-op writes", async () => {
    const before = loadData();
    const entries = before.courses[0]!.categories[0]!.entries;
    await api.updateGradeEntries(entries.map((entry) => ({ id: entry.id, patch: { max: 200 } })));
    expect(store.undo()).toEqual(before);
    await store.updateSettings({ gradeAlpha: before.settings.gradeAlpha });
    expect(store.historyState().canRedo).toBe(true);
    const after = store.redo()!;
    expect(after.courses[0]!.categories[0]!.entries.every((entry) => entry.max === 200)).toBe(true);
    store.undo();
    await api.updateGradeEntry(entries[0]!.id, { name: "New edit" });
    expect(store.redo()).toBeNull();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("assignment duplication", () => {
  it("inserts an independent copy immediately below the source and preserves all values", async () => {
    const category = loadData().courses[0]!.categories[0]!;
    const source = category.entries[0]!;
    await api.updateGradeEntry(source.id, { name: "Pset4", status: "ESTIMATED", notes: "Check rubric" });
    const copy = await api.duplicateGradeEntry(source.id);
    const entries = loadData().courses[0]!.categories[0]!.entries;
    expect(copy.id).not.toBe(source.id);
    expect(entries[1]).toMatchObject({
      name: "Pset4", points: source.points, max: source.max,
      status: "ESTIMATED", notes: "Check rubric",
    });
    expect(entries.map((entry) => entry.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(entries.slice(2).map((entry) => entry.id)).toEqual(category.entries.slice(1).map((entry) => entry.id));
    await api.updateGradeEntry(copy.id, { points: 0 });
    expect(loadData().courses[0]!.categories[0]!.entries[0]!.points).toBe(source.points);
  });

  it("copies a pending assignment without inventing a score", async () => {
    const source = loadData().courses[0]!.categories[0]!.entries[2]!;
    const copy = await api.duplicateGradeEntry(source.id);
    expect(copy.status).toBe("PENDING");
    expect(copy.points).toBeNull();
    expect(copy.max).toBe(source.max);
  });
});

describe("course ordering", () => {
  it("persists order without changing course data", async () => {
    await store.createCourse("Second class", "#123456");
    const before = loadData().courses;
    await store.reorderCourses(before.map((course) => course.id).reverse());
    expect(loadData().courses).toEqual([...before].reverse());
  });

  it("rejects an incomplete order without losing a course", async () => {
    const before = loadData().courses;
    expect(() => store.reorderCourses([])).toThrow(/class list changed/);
    expect(loadData().courses).toEqual(before);
  });
});
