import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, runTransaction, setDoc, deleteDoc, type Firestore } from "firebase/firestore";
import { createFirebaseTransport } from "../src/sync/firebase";
import { SyncEngine } from "../src/sync/engine";
import { toRecords, type Records } from "../src/sync/model";
import { loadData } from "../src/store";

// Opt-in integration tests: npm run test:rules under the local Firebase emulator.
// Never connects to a real project; default unit tests skip this suite.
const enabled = process.env.FIRESTORE_EMULATOR_HOST === "127.0.0.1:8085";
describe.skipIf(!enabled)("private Firestore security rules", () => {
  let environment: RulesTestEnvironment;
  const ownerClaims = { email: "sam.zhang.official@gmail.com", email_verified: true,
    firebase: { sign_in_provider: "google.com" } };
  const ownerDb = (uid = "alice") => environment.authenticatedContext(uid, ownerClaims).firestore();
  beforeAll(async () => {
    environment = await initializeTestEnvironment({ projectId: "demo-gradebook-sync", firestore: {
      host: "127.0.0.1", port: 8085, rules: readFileSync("firestore.rules", "utf8"),
    } });
  });
  beforeEach(async () => {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 1 });
      await setDoc(doc(db, "users/alice/gradebook/settings"), { version: 1, fields: { gradeAlpha: .1 } });
      await setDoc(doc(db, "users/alice/gradebook/entry:test"), { version: 1, fields: { points: 90 } });
    });
  });
  afterAll(async () => { await environment?.cleanup(); });
  it("denies unauthenticated reads, lists, creates, updates and deletes", async () => {
    const db = environment.unauthenticatedContext().firestore();
    const target = doc(db, "users/alice/gradebook/entry:test");
    await assertFails(getDoc(target));
    await assertFails(getDocs(collection(db, "users/alice/gradebook")));
    await assertFails(setDoc(target, { version: 1, fields: { points: 10 } }));
    await assertFails(setDoc(doc(db, "users/alice/gradebook/entry:new"), { version: 1, fields: {} }));
    await assertFails(deleteDoc(target));
  });
  it("denies another account's reads, collection lists and writes", async () => {
    const db = ownerDb("bob");
    await assertFails(getDoc(doc(db, "users/alice/gradebook/entry:test")));
    await assertFails(getDocs(collection(db, "users/alice/gradebook")));
    await assertFails(runTransaction(db, async (tx) => {
      tx.set(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 2 });
      tx.set(doc(db, "users/alice/gradebook/entry:test"), { version: 1, fields: { points: 0 } });
    }));
  });
  it("allows owner reads and atomic update/create/delete with a revision advance", async () => {
    const db = ownerDb();
    await assertSucceeds(getDocs(collection(db, "users/alice/gradebook")));
    await assertSucceeds(runTransaction(db, async (tx) => {
      const meta = doc(db, "users/alice/gradebook/_meta");
      const before = await tx.get(meta);
      tx.set(meta, { version: 1, revision: before.data()!.revision + 1 });
      tx.set(doc(db, "users/alice/gradebook/entry:new"), { version: 1, fields: { points: 95 } });
      tx.set(doc(db, "users/alice/gradebook/settings"), { version: 1, fields: { gradeAlpha: .2 } });
      tx.delete(doc(db, "users/alice/gradebook/entry:test"));
    }));
    expect((await getDoc(doc(db, "users/alice/gradebook/entry:new"))).data()!.fields.points).toBe(95);
  });
  it("allows first-time owner initialization", async () => {
    const db = ownerDb("bob");
    await assertSucceeds(runTransaction(db, async (tx) => {
      await tx.get(doc(db, "users/bob/gradebook/_meta"));
      tx.set(doc(db, "users/bob/gradebook/_meta"), { version: 1, revision: 1 });
      tx.set(doc(db, "users/bob/gradebook/settings"), { version: 1, fields: { gradeAlpha: .1 } });
    }));
  });
  it("denies blind writes, a missing revision advance, and revision rollback", async () => {
    const db = ownerDb();
    const target = doc(db, "users/alice/gradebook/entry:test");
    await assertFails(setDoc(target, { version: 1, fields: { points: 10 } }));
    await assertFails(deleteDoc(target));
    await assertFails(setDoc(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 1 }));
    await assertFails(setDoc(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 0 }));
    await assertFails(deleteDoc(doc(db, "users/alice/gradebook/_meta")));
  });
  it("rejects unknown schema, extra envelope keys and unrelated paths even for the owner", async () => {
    const db = ownerDb();
    await assertFails(setDoc(doc(db, "users/alice/other/private"), { fields: {} }));
    for (const record of [{ version: 2, fields: {} }, { version: 1, fields: [], unexpected: true }]) {
      await assertFails(runTransaction(db, async (tx) => {
        tx.set(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 2 });
        tx.set(doc(db, "users/alice/gradebook/entry:test"), record);
      }));
    }
  });
  it("runs two real SDK sync clients through merge, conflict and offline-queue reload", async () => {
    const records = toRecords(loadData());
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 1 });
      for (const [key, fields] of Object.entries(records)) await setDoc(doc(db, `users/alice/gradebook/${key}`), { version: 1, fields });
    });
    const db = ownerDb() as unknown as Firestore;
    const make = () => {
      let view = structuredClone(records);
      const engine = new SyncEngine(createFirebaseTransport(db, "alice"),
        { version: 1, base: records, local: records }, () => {}, (rows) => { view = structuredClone(rows); }, () => {});
      engine.start();
      return { engine, get view() { return view; } };
    };
    const a = make(), b = make();
    const key = "entry:sample-assignment-1";
    try {
      await vi.waitFor(() => { expect(a.engine.getState().status).toBe("synced"); expect(b.engine.getState().status).toBe("synced"); });
      const mine: Records = structuredClone(a.view); mine[key]!.points = 95;
      const theirs = structuredClone(b.view); theirs[key]!.notes = "Phone note";
      a.engine.edit(a.view, mine); b.engine.edit(b.view, theirs);
      await vi.waitFor(() => {
        expect(a.view[key]).toMatchObject({ points: 95, notes: "Phone note" });
        expect(b.view[key]).toMatchObject({ points: 95, notes: "Phone note" });
        expect(a.engine.getState().status).toBe("synced"); expect(b.engine.getState().status).toBe("synced");
      }, { timeout: 10000 });
      const cached = structuredClone(a.engine.getCache()); a.engine.stop();
      cached.local[key]!.points = 60;
      const phone = structuredClone(b.view); phone[key]!.points = 80;
      b.engine.edit(b.view, phone);
      await vi.waitFor(() => expect(b.engine.getState().status).toBe("synced"));
      const restored = new SyncEngine(createFirebaseTransport(db, "alice"), cached, () => {}, () => {}, () => {});
      restored.start();
      try {
        await vi.waitFor(() => expect(restored.getState().status).toBe("conflict"));
        expect(restored.getState().conflicts[0]).toMatchObject({ key, field: "points", local: 60, remote: 80 });
        restored.resolve("local");
        await vi.waitFor(() => {
          expect(restored.getState().status).toBe("synced"); expect(b.view[key]!.points).toBe(60);
        });
      } finally { restored.stop(); }
    } finally { a.engine.stop(); b.engine.stop(); }
  });
  it.each([
    { label: "another verified Google email", token: { ...ownerClaims, email: "other@example.com" } },
    { label: "unverified allowed email", token: { ...ownerClaims, email_verified: false } },
    { label: "a password-provider token", token: { ...ownerClaims, firebase: { sign_in_provider: "password" } } },
    { label: "an anonymous-provider token", token: { ...ownerClaims, firebase: { sign_in_provider: "anonymous" } } },
    { label: "missing email claims", token: { firebase: { sign_in_provider: "google.com" } } },
    { label: "missing verification claim", token: { email: ownerClaims.email, firebase: { sign_in_provider: "google.com" } } },
    { label: "a lookalike email", token: { ...ownerClaims, email: "sam.zhang.official@gmail.com.attacker.example" } },
  ])("denies $label even on its own UID's paths and with a valid transaction", async ({ token }) => {
    // Reuse the real owner's UID to prove the allowlist adds protection beyond
    // path ownership. Also check an attacker's own namespace cannot be created.
    const db = environment.authenticatedContext("alice", token).firestore();
    await assertFails(getDoc(doc(db, "users/alice/gradebook/settings")));
    await assertFails(getDocs(collection(db, "users/alice/gradebook")));
    await assertFails(runTransaction(db, async (tx) => {
      tx.set(doc(db, "users/alice/gradebook/_meta"), { version: 1, revision: 2 });
      tx.set(doc(db, "users/alice/gradebook/entry:test"), { version: 1, fields: { points: 0 } });
    }));
    await assertFails(deleteDoc(doc(db, "users/alice/gradebook/entry:test")));
    const attacker = environment.authenticatedContext("attacker", token).firestore();
    await assertFails(runTransaction(attacker, async (tx) => {
      tx.set(doc(attacker, "users/attacker/gradebook/_meta"), { version: 1, revision: 1 });
      tx.set(doc(attacker, "users/attacker/gradebook/settings"), { version: 1, fields: {} });
    }));
  });
});
