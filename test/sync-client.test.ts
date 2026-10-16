import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, Transport } from "../src/sync/engine";
import type { AppData } from "../src/store";
import { toRecords } from "../src/sync/model";

const mocks = vi.hoisted(() => ({
  authChanged: null as null | ((user: { uid: string; email: string; emailVerified: boolean; providerData: { providerId: string }[] } | null) => void),
  snapshot: null as Snapshot | null,
  reads: 0, writes: 0,
}));
vi.mock("../src/sync/firebase", () => ({
  observeAccount: (next: typeof mocks.authChanged) => { mocks.authChanged = next; next?.(null); return () => {}; },
  signIn: async () => { mocks.authChanged?.({ uid: "alice", email: "sam.zhang.official@gmail.com", emailVerified: true, providerData: [{ providerId: "google.com" }] }); },
  signOutAccount: async () => { mocks.authChanged?.(null); },
  firebaseTransport: (): Transport => ({
    refresh: async () => { mocks.reads++; return structuredClone(mocks.snapshot!); },
    watch: (next) => { next(structuredClone(mocks.snapshot!)); return () => {}; },
    commit: async (expected, records) => {
      mocks.writes++; mocks.snapshot = { revision: expected.revision + 1, records: structuredClone(records) };
      return structuredClone(mocks.snapshot);
    },
  }),
}));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let local: AppData;
let client: typeof import("../src/sync/client");
let store: typeof import("../src/store");
let values: Map<string, string>;

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubEnv("VITE_FIREBASE_API_KEY", "public-test-key");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "demo.test");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "demo-gradebook-sync");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "test-app");
  values = new Map();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  }, addEventListener: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true, locks: {
    request: (_name: string, _options: unknown, fn: (lock: object) => Promise<void>) => fn({}),
  } });
  store = await import("../src/store");
  local = store.loadData(); local.courses[0]!.name = "Local course";
  values.set("gradebook.data.v1", JSON.stringify(local));
  mocks.reads = 0; mocks.writes = 0;
  mocks.snapshot = { revision: 0, records: {} };
  client = await import("../src/sync/client");
});
afterEach(async () => {
  await client.disconnectSync(); await settle();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("account connection and data adoption", () => {
  it.each([
    { email: "other@example.com", emailVerified: true, providerData: [{ providerId: "google.com" }] },
    { email: "sam.zhang.official@gmail.com", emailVerified: false, providerData: [{ providerId: "google.com" }] },
    { email: "sam.zhang.official@gmail.com", emailVerified: true, providerData: [{ providerId: "password" }] },
  ])("blocks unauthorized identities before reading or writing Firestore: %o", async (identity) => {
    await client.initializeSync();
    mocks.authChanged?.({ uid: "blocked-user", ...identity }); await settle();
    expect(client.getSyncState().phase).toBe("error");
    expect(client.getSyncState().error).toContain("restricted");
    expect(mocks.reads).toBe(0); expect(mocks.writes).toBe(0);
    expect(store.loadData()).toEqual(local);
  });
  it("does not contact Firebase at all when build config is absent", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "");
    vi.resetModules(); client = await import("../src/sync/client");
    await client.initializeSync(); await settle();
    expect(client.getSyncState()).toMatchObject({ configured: false, phase: "local" });
    expect(mocks.reads).toBe(0); expect(mocks.writes).toBe(0);
  });
  it("does not upload simply because the user signed in", async () => {
    await client.initializeSync(); await client.connectGoogle(); await settle();
    expect(client.getSyncState()).toMatchObject({ phase: "choose", cloudExists: false });
    expect(mocks.writes).toBe(0);
    expect(store.loadData()).toEqual(local);
    await client.chooseData("local"); await settle();
    expect(client.getSyncState().phase).toBe("connected");
    expect(mocks.snapshot!.records["course:sample-course"]!.name).toBe("Local course");
    expect(mocks.writes).toBe(1);
    await client.disconnectSync(); await settle();
    expect(store.loadData()).toEqual(local);
    expect(client.getSyncState().phase).toBe("local");
  });
  it("adopts cloud data without uploading or overwriting the local-only gradebook", async () => {
    const cloud = structuredClone(local); cloud.courses[0]!.name = "Cloud course";
    mocks.snapshot = { revision: 1, records: toRecords(cloud) };
    await client.initializeSync(); await client.connectGoogle(); await settle();
    expect(client.getSyncState().cloudExists).toBe(true);
    await client.chooseData("cloud"); await settle();
    expect(store.loadData()).toEqual(cloud);
    expect(mocks.writes).toBe(0);
    await client.disconnectSync(); await settle(); expect(store.loadData()).toEqual(local);
  });
  it("adds local copies with new IDs and keeps cloud defaults", async () => {
    const cloud = structuredClone(local); cloud.courses[0]!.name = "Cloud course";
    cloud.settings.gradeAlpha = .05;
    mocks.snapshot = { revision: 1, records: toRecords(cloud) };
    await client.initializeSync(); await client.connectGoogle(); await settle();
    await client.chooseData("merge"); await settle();
    const merged = store.loadData();
    expect(merged.courses.map((course) => course.name)).toEqual(["Cloud course", "Local course"]);
    expect(merged.courses[0]!.id).not.toBe(merged.courses[1]!.id);
    expect(merged.settings.gradeAlpha).toBe(.05);
    expect(mocks.writes).toBe(1);
  });
  it("does not allow an upload to replace an existing cloud account", async () => {
    mocks.snapshot = { revision: 1, records: toRecords(local) };
    await client.initializeSync(); await client.connectGoogle(); await settle();
    await client.chooseData("local"); await settle();
    expect(client.getSyncState().error).toContain("already exists");
    expect(mocks.writes).toBe(0);
  });
  it("syncs backup restore, undo and redo as new revisions without changing the guest profile", async () => {
    const cloud = structuredClone(local);
    mocks.snapshot = { revision: 10, records: toRecords(cloud) };
    await client.initializeSync(); await client.connectGoogle(); await settle();
    await client.chooseData("cloud"); await settle();
    const backup = structuredClone(cloud);
    backup.courses = [];
    backup.gpaTerms = [{ id: "backup-term", name: "Backup term", courses: [{ id: "backup-course", name: "CS", grade: "A", units: 5 }] }];
    backup.settings.gradeAlpha = .2;
    await store.store.restoreBackup(backup); await settle();
    expect(mocks.snapshot).toEqual({ revision: 11, records: toRecords(backup) });
    store.store.undo(); await settle();
    expect(mocks.snapshot).toEqual({ revision: 12, records: toRecords(cloud) });
    store.store.redo(); await settle();
    expect(mocks.snapshot).toEqual({ revision: 13, records: toRecords(backup) });
    await client.disconnectSync(); await settle();
    expect(store.loadData()).toEqual(local);
  });
  it("keeps a second same-browser tab local-only when the sync lock is occupied", async () => {
    vi.stubGlobal("navigator", { onLine: true, locks: {
      request: (_name: string, _options: unknown, fn: (lock: null) => Promise<void>) => fn(null),
    } });
    await client.initializeSync(); await client.connectGoogle(); await settle();
    expect(client.getSyncState()).toMatchObject({ phase: "error" });
    expect(client.getSyncState().error).toContain("another tab");
    expect(mocks.reads).toBe(0); expect(mocks.writes).toBe(0);
    expect(store.loadData()).toEqual(local);
  });
  it("does not roll back cloud data when the displayed account cache lagged during typing", async () => {
    const cloud = structuredClone(local);
    cloud.courses[0]!.categories[0]!.entries[0]!.points = 70;
    const rows = toRecords(cloud);
    mocks.snapshot = { revision: 2, records: rows };
    values.set("gradebook.sync.v1.demo-gradebook-sync.alice", JSON.stringify({
      version: 1, base: rows, local: rows, view: toRecords(local),
    }));
    values.set("gradebook.data.v1.account.demo-gradebook-sync.alice", JSON.stringify(local));
    await client.initializeSync(); await client.connectGoogle(); await settle();
    expect(store.loadData()).toEqual(cloud);
    expect(mocks.writes).toBe(0);
  });
  it("recovers an edit saved after a failed outbox write without restoring an entire stale snapshot", async () => {
    const edited = structuredClone(local);
    edited.courses[0]!.categories[0]!.entries[0]!.points = 96;
    const rows = toRecords(local);
    mocks.snapshot = { revision: 1, records: rows };
    values.set("gradebook.sync.v1.demo-gradebook-sync.alice", JSON.stringify({
      version: 1, base: rows, local: rows, view: rows,
    }));
    values.set("gradebook.data.v1.account.demo-gradebook-sync.alice", JSON.stringify(edited));
    await client.initializeSync(); await client.connectGoogle(); await settle();
    expect(store.loadData()).toEqual(edited);
    expect(mocks.snapshot!.records["entry:sample-assignment-1"]!.points).toBe(96);
    expect(mocks.writes).toBe(1);
  });
});
