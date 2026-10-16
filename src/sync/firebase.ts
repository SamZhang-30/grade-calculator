import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { collection, doc, getDocsFromServer, getFirestore, onSnapshot, runTransaction,
  type QuerySnapshot } from "firebase/firestore";
import type { Firestore } from "firebase/firestore";
import { StaleSnapshot, type Snapshot, type Transport } from "./engine";
import { changedKeys, validateRecords, type RecordData, type Records } from "./model";
import { firebaseConfig, firebaseConfigured } from "./config";

// Not initialized at all in local-only builds. No requests, accounts, or cloud
// dependency are required to keep using the calculator without configuration.
const app = firebaseConfigured ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

export const observeAccount = (next: (user: User | null) => void, error: (error: Error) => void) =>
  auth ? onAuthStateChanged(auth, next, error) : () => {};
export async function signIn() {
  if (!auth) throw new Error("Firebase has not been configured yet.");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(auth, provider);
}
export async function signOutAccount() { if (auth) await signOut(auth); }

function decode(snapshot: QuerySnapshot): Snapshot {
  const records: Records = {};
  let revision = 0;
  let hasMeta = false;
  for (const item of snapshot.docs) {
    const value = item.data();
    if (item.id === "_meta") {
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) {
        throw new Error("Unsupported cloud data format. Sync has been paused.");
      }
      revision = value.revision; hasMeta = true;
    } else {
      if (value.version !== 1 || !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields) ||
          Object.values(value.fields).some((field) => field !== null &&
            !["string", "number", "boolean"].includes(typeof field))) {
        throw new Error("Invalid cloud record. Sync has been paused; no data was overwritten.");
      }
      records[item.id] = value.fields as RecordData;
    }
  }
  if ((!hasMeta && Object.keys(records).length) || (hasMeta && !records.settings)) {
    throw new Error("Incomplete cloud gradebook. Sync has been paused.");
  }
  if (hasMeta) validateRecords(records);
  return { revision, records };
}

export function firebaseTransport(uid: string): Transport {
  if (!db) throw new Error("Firebase has not been configured yet.");
  return createFirebaseTransport(db, uid);
}

export function createFirebaseTransport(database: Firestore, uid: string): Transport {
  const rows = collection(database, "users", uid, "gradebook");
  return {
    watch: (next, error) => onSnapshot(rows, { includeMetadataChanges: true }, (snapshot) => {
      // A cache snapshot is not a transaction baseline. Local data/outbox stays
      // usable offline without treating an empty SDK cache as an empty account.
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      try { next(decode(snapshot)); } catch (cause) { error(cause as Error); }
    }, error),
    refresh: async () => decode(await getDocsFromServer(rows)),
    commit: async (expected, records) => {
      const keys = changedKeys(expected.records, records);
      if (keys.length > 499) {
        throw new Error("This change touches more than 499 records. It is saved locally, but cannot sync as one atomic change. Reduce the pending import or edit before retrying.");
      }
      const meta = doc(rows, "_meta");
      await runTransaction(database, async (transaction) => {
        const current = await transaction.get(meta);
        const revision = current.exists() ? current.data().revision : 0;
        // Every write advances this fence. This ensures the full collection
        // used by the merge was current, including newly added descendants.
        if (revision !== expected.revision) throw new StaleSnapshot("Cloud data changed. Refreshing before retrying.");
        for (const key of keys) {
          const target = doc(rows, key);
          if (records[key]) transaction.set(target, { version: 1, fields: records[key] });
          else transaction.delete(target);
        }
        transaction.set(meta, { version: 1, revision: revision + 1 });
      });
      return { revision: expected.revision + 1, records };
    },
  };
}
