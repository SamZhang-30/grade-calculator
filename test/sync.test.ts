import { describe, expect, it, vi } from "vitest";
import { loadData } from "../src/store";
import { changedKeys, fromRecords, mergeRecords, toRecords, type Records } from "../src/sync/model";
import { StaleSnapshot, SyncEngine, type EngineState, type Snapshot, type SyncCache, type Transport } from "../src/sync/engine";

const data = loadData();
data.gpaTerms = [{ id: "term1", name: "Autumn", courses: [{ id: "gpa1", name: "MATH", grade: "A", units: 5 }] }];
const base = toRecords(data);
const entry = "entry:sample-assignment-1";
const course = "course:sample-course";
const copy = () => structuredClone(base);
const edit = (records: Records, key: string, field: string, value: string | number | null) => {
  const next = structuredClone(records); next[key]![field] = value; return next;
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("record-level sync model", () => {
  it("round trips every stored field, course ordering, assignments, and GPA terms", () => {
    expect(fromRecords(base)).toEqual(data);
    expect(changedKeys(base, copy())).toEqual([]);
  });
  it("merges concurrent edits to different fields of the same assignment", () => {
    const local = edit(base, entry, "points", 99);
    const remote = edit(base, entry, "notes", "From phone");
    const merged = mergeRecords(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.records[entry]).toMatchObject({ points: 99, notes: "From phone" });
    expect(changedKeys(remote, merged.records)).toEqual([entry]);
  });
  it("requires a choice for the same field, preserving unrelated edits", () => {
    const local = edit(edit(base, entry, "points", 95), "gpa-course:gpa1", "grade", "B+");
    const remote = edit(edit(base, entry, "points", 80), course, "name", "Phone course");
    const mine = mergeRecords(base, local, remote);
    const theirs = mergeRecords(base, local, remote, "remote");
    expect(mine.conflicts).toMatchObject([{ key: entry, field: "points", local: 95, remote: 80 }]);
    expect(mine.records[entry]!.points).toBe(95);
    expect(theirs.records[entry]!.points).toBe(80);
    for (const result of [mine, theirs]) {
      expect(result.records[course]!.name).toBe("Phone course");
      expect(result.records["gpa-course:gpa1"]!.grade).toBe("B+");
    }
  });
  it("does not conflict when both devices choose the same value", () => {
    const local = edit(base, entry, "points", 95);
    expect(mergeRecords(base, local, local).conflicts).toEqual([]);
  });
  it("preserves both independently added records", () => {
    const a = copy(), b = copy();
    a["entry:a"] = { ...a[entry]!, id: "a", _order: 5 };
    b["entry:b"] = { ...b[entry]!, id: "b", _order: 5 };
    const result = mergeRecords(base, a, b);
    expect(result.conflicts).toEqual([]);
    expect(fromRecords(result.records).courses[0]!.categories[0]!.entries.slice(-2).map((row) => row.id)).toEqual(["a", "b"]);
  });
  it.each(["edit", "add"])("detects category deletion versus remote descendant %s", (action) => {
    const a = copy(), b = copy();
    const category = "category:sample-coursework";
    for (const [key, row] of Object.entries(a)) if (key === category || row._parent === category) delete a[key];
    if (action === "edit") b[entry]!.points = 70;
    else b["entry:new"] = { ...b[entry]!, id: "new", _order: 8 };
    const mine = mergeRecords(base, a, b);
    const theirs = mergeRecords(base, a, b, "remote");
    expect(mine.conflicts[0]).toMatchObject({ key: category, field: "record and children" });
    expect(fromRecords(mine.records).courses[0]!.categories).toHaveLength(1);
    expect(fromRecords(theirs.records).courses[0]!.categories[0]!.entries).toHaveLength(action === "add" ? 4 : 3);
  });
  it("detects remote course deletion versus local child edit and restores a valid branch", () => {
    const remote = copy();
    for (const [key] of Object.entries(remote)) if (["course:", "category:", "entry:"].some((prefix) => key.startsWith(prefix))) delete remote[key];
    const local = edit(base, entry, "points", 70);
    const result = mergeRecords(base, local, remote);
    expect(result.conflicts[0]!.key).toBe(course);
    expect(fromRecords(result.records).courses[0]!.categories[0]!.entries[0]!.points).toBe(70);
    expect(fromRecords(mergeRecords(base, local, remote, "remote").records).courses).toEqual([]);
  });
  it("rejects duplicate IDs, invalid cloud fields, and orphaned records", () => {
    const dup = structuredClone(data);
    dup.courses[0]!.categories[0]!.entries.push({ ...dup.courses[0]!.categories[0]!.entries[0]! });
    expect(() => toRecords(dup)).toThrow("unique");
    expect(() => fromRecords(edit(base, entry, "status", "INVALID"))).toThrow("Unsupported cloud record");
    const orphan = copy(); delete orphan["category:sample-coursework"];
    expect(() => fromRecords(orphan)).toThrow("hierarchy");
  });
});

class FakeServer {
  snapshot: Snapshot = { revision: 1, records: copy() };
  online = true;
  failStaleOnce = false;
  commitCount = 0;
  gate: Promise<void> | null = null;
  listeners = new Set<(snapshot: Snapshot) => void>();
  transport(): Transport {
    return {
      watch: (next) => { this.listeners.add(next); if (this.online) next(structuredClone(this.snapshot)); return () => { this.listeners.delete(next); }; },
      refresh: async () => { if (!this.online) throw new Error("Offline"); return structuredClone(this.snapshot); },
      commit: async (expected, records) => {
        if (this.gate) await this.gate;
        if (!this.online) throw new Error("Offline");
        if (this.failStaleOnce) {
          this.failStaleOnce = false;
          this.snapshot = { revision: this.snapshot.revision + 1, records: edit(this.snapshot.records, course, "name", "Race edit") };
        }
        if (expected.revision !== this.snapshot.revision) throw new StaleSnapshot();
        this.commitCount++;
        this.snapshot = { revision: expected.revision + 1, records: structuredClone(records) };
        const ack = structuredClone(this.snapshot);
        this.listeners.forEach((fn) => fn(structuredClone(ack)));
        return ack;
      },
    };
  }
  remoteEdit(key: string, field: string, value: string | number) {
    this.snapshot = { revision: this.snapshot.revision + 1, records: edit(this.snapshot.records, key, field, value) };
    this.listeners.forEach((fn) => fn(structuredClone(this.snapshot)));
  }
}
function client(server: FakeServer, cached?: SyncCache) {
  let cache: SyncCache = cached ?? { version: 1, base: copy(), local: copy() };
  let view = copy();
  let state: EngineState | null = null;
  const engine = new SyncEngine(server.transport(), cache,
    (next) => { cache = structuredClone(next); }, (rows) => { view = structuredClone(rows); }, (next) => { state = next; });
  engine.start();
  return { engine, get cache() { return cache; }, get view() { return view; }, get state() { return state; },
    change: (key: string, field: string, value: string | number) => engine.edit(view, edit(view, key, field, value)) };
}

describe("durable sync outbox", () => {
  it("updates another connected device and writes only changed records", async () => {
    const server = new FakeServer();
    const a = client(server), b = client(server);
    a.change(entry, "points", 93);
    await settle();
    expect(b.view[entry]!.points).toBe(93);
    expect(a.state!.status).toBe("synced");
    expect(server.commitCount).toBe(1);
    a.engine.stop(); b.engine.stop();
  });
  it("persists offline changes across reload and merges another device's work on reconnect", async () => {
    const server = new FakeServer();
    const a = client(server);
    server.online = false;
    a.change(entry, "points", 96);
    await settle();
    expect(a.cache.local[entry]!.points).toBe(96);
    expect(a.state!.status).toBe("error");
    a.engine.stop();
    server.snapshot = { revision: 2, records: edit(server.snapshot.records, entry, "notes", "Phone offline edit") };
    const reloaded = client(server, a.cache);
    server.online = true;
    await reloaded.engine.retry(); await settle();
    expect(reloaded.view[entry]).toMatchObject({ points: 96, notes: "Phone offline edit" });
    expect(server.snapshot.records[entry]).toMatchObject({ points: 96, notes: "Phone offline edit" });
    expect(reloaded.state!.status).toBe("synced");
    reloaded.engine.stop();
  });
  it.each(["local", "remote"] as const)("pauses on a same-field conflict until explicitly choosing %s", async (choice) => {
    const server = new FakeServer(); const a = client(server);
    server.online = false;
    a.change(entry, "points", 96); await settle();
    server.snapshot = { revision: 2, records: edit(base, entry, "points", 70) };
    server.online = true;
    await a.engine.retry(); await settle();
    expect(a.state!.status).toBe("conflict");
    expect(server.commitCount).toBe(0);
    a.engine.resolve(choice); await settle();
    expect(server.snapshot.records[entry]!.points).toBe(choice === "local" ? 96 : 70);
    expect(a.state!.status).toBe("synced"); a.engine.stop();
  });
  it("retains edits made while an upload is in flight", async () => {
    const server = new FakeServer(); const a = client(server);
    let release!: () => void;
    server.gate = new Promise((resolve) => { release = resolve; });
    a.change(entry, "points", 94);
    a.change(entry, "points", 99);
    a.change("gpa-course:gpa1", "grade", "A+");
    server.gate = null; release(); await settle();
    expect(server.snapshot.records[entry]!.points).toBe(99);
    expect(server.snapshot.records["gpa-course:gpa1"]!.grade).toBe("A+");
    expect(a.state!.status).toBe("synced"); a.engine.stop();
  });
  it("re-reads after a revision race rather than overwriting an unseen remote edit", async () => {
    const server = new FakeServer(); const a = client(server);
    server.failStaleOnce = true;
    a.change(entry, "points", 94); await settle();
    expect(server.snapshot.records[course]!.name).toBe("Race edit");
    expect(server.snapshot.records[entry]!.points).toBe(94);
    expect(a.state!.status).toBe("synced"); a.engine.stop();
  });
  it("does not publish an ack into a signed-out/replaced account", async () => {
    const server = new FakeServer(); const a = client(server);
    let release!: () => void;
    server.gate = new Promise((resolve) => { release = resolve; });
    a.change(entry, "points", 94); a.engine.stop();
    const cacheBefore = structuredClone(a.cache);
    server.gate = null; release(); await settle();
    expect(a.cache).toEqual(cacheBefore);
    expect(server.listeners.size).toBe(0);
  });
  it("never uploads when the durable queue cannot be saved", async () => {
    const server = new FakeServer(); const publish = vi.fn();
    const engine = new SyncEngine(server.transport(), { version: 1, base: copy(), local: copy() },
      () => { throw new Error("Storage full"); }, publish, () => {});
    engine.start(); engine.edit(base, edit(base, entry, "points", 95)); await settle();
    expect(server.commitCount).toBe(0);
    expect(engine.getState().error).toBe("Storage full"); engine.stop();
  });
  it("conflicts on a draft committed against an older displayed value", async () => {
    const server = new FakeServer(); const a = client(server);
    const displayedBeforeTyping = structuredClone(a.view);
    server.remoteEdit(entry, "points", 70);
    const draft = edit(displayedBeforeTyping, entry, "points", 96);
    a.engine.edit(displayedBeforeTyping, draft); await settle();
    expect(a.state!.status).toBe("conflict");
    expect(a.state!.conflicts[0]).toMatchObject({ field: "points", local: 96, remote: 70 });
    expect(server.commitCount).toBe(0); a.engine.stop();
  });
  it("acknowledges an identical concurrent edit before a later remote change", async () => {
    const server = new FakeServer(); const a = client(server);
    server.online = false; a.change(entry, "points", 95); await settle();
    server.online = true; server.remoteEdit(entry, "points", 95); await settle();
    expect(a.state!.status).toBe("synced");
    expect(a.cache.base).toEqual(a.cache.local);
    server.remoteEdit(entry, "points", 80); await settle();
    expect(a.view[entry]!.points).toBe(80);
    expect(a.state!.conflicts).toEqual([]); a.engine.stop();
  });
});
