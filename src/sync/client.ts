import { applySyncedData, loadData, profileData, subscribeCommits, switchProfile } from "../store";
import { firebaseConfig, firebaseConfigured } from "./config";
import { SyncEngine, type EngineState, type Snapshot, type SyncCache, type Transport } from "./engine";
import { fromRecords, mergeRecords, same, toRecords, validateRecords, type Records } from "./model";
import { permittedSyncAccount, type SyncAccount } from "./access";

type FirebaseModule = typeof import("./firebase");
type Account = SyncAccount;
export interface SyncState {
  configured: boolean;
  phase: "local" | "loading" | "choose" | "connected" | "error";
  account: Account | null;
  engine: EngineState | null;
  error: string;
  cloudExists: boolean;
}
let state: SyncState = { configured: firebaseConfigured, phase: "local", account: null,
  engine: null, error: "", cloudExists: false };
const listeners = new Set<() => void>();
const emit = (patch: Partial<SyncState>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn()); };
export const getSyncState = () => state;
export const subscribeSync = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
let firebase: FirebaseModule | null = null;
let initialized = false;
let engine: SyncEngine | null = null;
let stopCommits: (() => void) | null = null;
let releaseLock: (() => void) | null = null;
let generation = 0;
let cloud: Snapshot | null = null;
let transport: Transport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let deferredRows: Records | null = null;
let activeAccountProfile = false;
let stopAuth: (() => void) | null = null;
const cacheKey = (uid: string) => `gradebook.sync.v1.${firebaseConfig.projectId}.${uid}`;
const profileKey = (uid: string) => `${firebaseConfig.projectId}.${uid}`;

function readCache(uid: string): SyncCache | null {
  const raw = window.localStorage.getItem(cacheKey(uid));
  if (!raw) return null;
  const cache = JSON.parse(raw) as SyncCache;
  if (cache.version !== 1 || !cache.base || !cache.local) throw new Error("The saved sync queue is unsupported. Export your data before clearing it.");
  fromRecords(cache.local);
  if (Object.keys(cache.base).length) validateRecords(cache.base);
  if (cache.view) validateRecords(cache.view);
  return cache;
}
function persistCache(uid: string, cache: SyncCache, view: Records) {
  try { window.localStorage.setItem(cacheKey(uid), JSON.stringify({ ...cache, view })); }
  catch { throw new Error("The sync queue could not be saved. Your change is still in the local gradebook; free browser storage before retrying."); }
}
function stopSession() {
  engine?.stop(); engine = null;
  stopCommits?.(); stopCommits = null;
  if (timer) clearInterval(timer);
  timer = null;
  releaseLock?.(); releaseLock = null;
  transport = null; cloud = null;
  deferredRows = null;
}
function fail(cause: unknown) {
  emit({ error: cause instanceof Error ? cause.message : String(cause) });
}
function connect(account: Account, cache: SyncCache, session: number) {
  if (session !== generation || !transport) return;
  persistCache(account.uid, cache, cache.local);
  switchProfile(profileKey(account.uid), fromRecords(cache.local));
  activeAccountProfile = true;
  emit({ phase: "connected", error: "", engine: null });
  engine = new SyncEngine(transport, cache, (next) => persistCache(account.uid, next, toRecords(loadData())),
    (rows) => {
      if (typeof document !== "undefined" && document.activeElement?.matches("input, textarea, [contenteditable='true']")) {
        deferredRows = rows;
      } else {
        deferredRows = null;
        applySyncedData(fromRecords(rows));
      }
    }, (next) => emit({ engine: next }));
  stopCommits = subscribeCommits((before, after) => {
    try { engine?.edit(toRecords(before), toRecords(after)); }
    catch (cause) { fail(cause); }
  });
  engine.start();
  // Snapshot listeners reconnect on their own; the outbox also retries online
  // transactions after network recovery, without a reload or new edit.
  timer = setInterval(() => {
    if (!navigator.onLine || !engine) return;
    const next = engine.getState();
    if (next.status === "pending" || next.status === "connecting" ||
        (next.status === "error" && next.retryable)) void engine.retry();
  }, 15000);
}

async function openSession(account: Account, session: number) {
  if (!firebase || session !== generation) return;
  transport = firebase.firebaseTransport(account.uid);
  const cached = readCache(account.uid);
  if (cached) {
    // Recover ONLY differences from the display saved at the last outbox
    // write. A display deferred during typing can lag an acknowledged remote
    // update; blindly treating that older display as local edits rolls it back.
    const saved = profileData(profileKey(account.uid));
    if (saved && cached.view) {
      const current = toRecords(saved);
      if (!same(current, cached.view)) {
        const captured = mergeRecords(cached.view, current, cached.local);
        if (captured.conflicts.length) cached.base = mergeRecords(current, cached.view, cached.base).records;
        cached.local = captured.records;
      }
    }
    connect(account, cached, session);
    return;
  }
  cloud = await transport.refresh();
  if (session !== generation) return;
  emit({ phase: "choose", cloudExists: cloud.revision > 0, error: "" });
}

async function onAccount(account: Account | null) {
  const session = ++generation;
  // Finish any old account's draft before changing the persistence namespace.
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  stopSession();
  if (activeAccountProfile) { switchProfile(null); activeAccountProfile = false; }
  emit({ account, phase: account ? "loading" : "local", engine: null, error: "", cloudExists: false });
  if (!account) return;
  if (!permittedSyncAccount(account)) {
    emit({ phase: "error", error: "Cloud sync is restricted to the owner's verified Google account. Sign out and choose the authorized account. Local-only use is still available." });
    return;
  }
  // A single durable queue per account/browser is protected from concurrent
  // tabs. Other devices have independent queues and merge through Firestore.
  if (!navigator.locks) {
    emit({ phase: "error", error: "Cloud sync needs a browser with Web Locks support. Local-only mode still works." });
    return;
  }
  void navigator.locks.request(`gradebook-sync:${firebaseConfig.projectId}:${account.uid}`,
    { ifAvailable: true }, async (lock) => {
      if (session !== generation) return;
      if (!lock) {
        emit({ phase: "error", error: "Cloud sync is already open in another tab. Close that tab, then retry here. This tab is still local-only." });
        return;
      }
      const held = new Promise<void>((resolve) => { releaseLock = resolve; });
      try { await openSession(account, session); }
      catch (cause) { if (session === generation) { emit({ phase: "error" }); fail(cause); } }
      await held;
    }).catch((cause) => { if (session === generation) { emit({ phase: "error" }); fail(cause); } });
}

export async function initializeSync() {
  if (initialized || !firebaseConfigured) return;
  initialized = true;
  emit({ phase: "loading" });
  try {
    firebase = await import("./firebase");
    stopAuth = firebase.observeAccount((user) => { void onAccount(user ? {
      uid: user.uid, email: user.email, emailVerified: user.emailVerified,
      providers: user.providerData.map((provider) => provider.providerId),
    } : null); },
      (cause) => { emit({ phase: "error" }); fail(cause); });
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("focusout", focusout);
  } catch (cause) { emit({ phase: "error" }); fail(cause); }
}
export async function connectGoogle() {
  try {
    if (!firebase) firebase = await import("./firebase");
    emit({ error: "" });
    await firebase.signIn();
  } catch (cause) { fail(cause); }
}
export async function chooseData(choice: "cloud" | "local" | "merge") {
  if (!state.account || !cloud || !transport) return;
  try {
    // Re-fetch before adoption. The transaction fence will also detect any
    // intervening write between this confirmation and the first upload.
    cloud = await transport.refresh();
    const local = toRecords(loadData());
    let rows: Records;
    if (choice === "cloud") {
      if (!cloud.records.settings) throw new Error("This account has no cloud gradebook yet. Upload this device's gradebook instead.");
      rows = cloud.records;
    } else if (cloud.revision && choice === "local") {
      throw new Error("A cloud gradebook already exists. Choose cloud data or add this device's classes without replacing it.");
    } else if (choice === "merge") {
      rows = { ...cloud.records };
      // Copy with new IDs, so merging two copies of the same imported class
      // never silently replaces an existing cloud record.
      const copy = structuredClone(loadData());
      const ids = new Map<string, string>();
      const remap = (id: string) => {
        if (!ids.has(id)) ids.set(id, crypto.randomUUID());
        return ids.get(id)!;
      };
      for (const course of copy.courses) {
        course.id = remap(course.id);
        for (const category of course.categories) {
          category.id = remap(category.id);
          for (const entry of category.entries) entry.id = remap(entry.id);
        }
      }
      for (const term of copy.gpaTerms) {
        term.id = remap(term.id);
        for (const course of term.courses) course.id = remap(course.id);
      }
      const imported = toRecords(copy);
      for (const [key, row] of Object.entries(imported)) {
        if (key === "settings") continue; // Existing account defaults win.
        if (row._parent === null) {
          const kind = key.split(":")[0];
          const max = Math.max(-1, ...Object.entries(rows).filter(([k, r]) => k.startsWith(`${kind}:`) && r._parent === null).map(([, r]) => Number(r._order)));
          row._order = max + 1;
        }
        rows[key] = row;
      }
      rows.settings ??= imported.settings!;
    } else rows = local;
    connect(state.account, { version: 1, base: cloud.records, local: rows }, generation);
  } catch (cause) { fail(cause); }
}
export async function retrySync() {
  emit({ error: "" });
  if (engine) await engine.retry();
  else if (state.account) await onAccount(state.account);
  else if (!firebase && firebaseConfigured) { initialized = false; await initializeSync(); }
}
export function resolveConflicts(choice: "local" | "remote") { engine?.resolve(choice); }
export async function disconnectSync() {
  try { await firebase?.signOutAccount(); }
  catch (cause) { fail(cause); }
}

const online = () => { void engine?.retry(); };
const offline = () => {
  if (engine) emit({ engine: { ...engine.getState(), status: "pending", error: "Offline — edits are saved on this device and will sync when you reconnect." } });
};
const focusout = () => {
  if (!deferredRows) return;
  const rows = deferredRows; deferredRows = null;
  try { applySyncedData(fromRecords(rows)); } catch (cause) { fail(cause); }
};
if (import.meta.hot) import.meta.hot.dispose(() => {
  ++generation;
  stopSession(); stopAuth?.();
  window.removeEventListener("online", online);
  window.removeEventListener("offline", offline);
  window.removeEventListener("focusout", focusout);
});
