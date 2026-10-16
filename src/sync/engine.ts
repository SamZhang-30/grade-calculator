import { changedKeys, mergeRecords, same, type Conflict, type Records } from "./model";

export interface Snapshot { revision: number; records: Records }
export interface SyncCache { version: 1; base: Records; local: Records; view?: Records }
export interface Transport {
  watch: (next: (snapshot: Snapshot) => void, error: (error: Error) => void) => () => void;
  refresh: () => Promise<Snapshot>;
  commit: (expected: Snapshot, records: Records) => Promise<Snapshot>;
}
export class StaleSnapshot extends Error {}
export interface EngineState {
  status: "connecting" | "synced" | "pending" | "conflict" | "error";
  pending: number;
  conflicts: Conflict[];
  error: string;
  retryable: boolean;
}

/** Durable outbox + three-way merge. Transactions are online-only; this queue,
 * rather than Firestore's blind offline writes, preserves conflict detection.
 */
export class SyncEngine {
  private base: Records;
  private local: Records;
  private remote: Snapshot | null = null;
  private disposed = false;
  private pumping = false;
  private unsubscribe: (() => void) | null = null;
  private watchFailed = false;
  private state: EngineState = { status: "connecting", pending: 0, conflicts: [], error: "", retryable: false };

  constructor(private transport: Transport, cache: SyncCache,
    private persist: (cache: SyncCache) => void,
    private publish: (records: Records) => void,
    private notify: (state: EngineState) => void) {
    this.base = structuredClone(cache.base);
    this.local = structuredClone(cache.local);
  }

  start() {
    try { this.reconcile(); } catch (error) { this.fail(error as Error); }
    this.watch();
  }
  private watch() {
    this.watchFailed = false;
    this.unsubscribe = this.transport.watch((snapshot) => this.receive(snapshot), (error) => {
      this.watchFailed = true; this.fail(error);
    });
  }
  stop() { this.disposed = true; this.unsubscribe?.(); }
  getState() { return this.state; }
  getCache(): SyncCache { return { version: 1, base: structuredClone(this.base), local: structuredClone(this.local) }; }
  private update(state: Partial<EngineState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...state };
    this.notify(this.state);
  }
  private fail(error: Error) {
    const code = (error as Error & { code?: string }).code?.replace(/^firestore\//, "");
    const retryable = ["unavailable", "deadline-exceeded", "aborted", "network-request-failed"].includes(code ?? "") || error.message === "Offline";
    this.update({ status: "error", retryable, error: error.message || "Cloud sync is unavailable. Your edits remain on this device." });
  }
  private reconcile() {
    const remote = this.remote?.records ?? this.base;
    const merged = mergeRecords(this.base, this.local, remote);
    if (this.remote && !merged.conflicts.length && same(merged.records, remote)) {
      // Another device can have already written our exact desired value. That
      // is an acknowledgement too, not a pending edit that should conflict
      // with that device's next (later) change.
      this.base = structuredClone(remote);
      this.local = structuredClone(remote);
    }
    // Save the outbox before announcing a successful queue/sync state.
    this.persist(this.getCache());
    this.publish(merged.records);
    this.update({ conflicts: merged.conflicts, pending: changedKeys(remote, merged.records).length,
      error: "", retryable: false, status: merged.conflicts.length ? "conflict" : !this.remote ? "connecting" :
        same(remote, merged.records) ? "synced" : "pending" });
  }
  receive(snapshot: Snapshot) {
    if (this.disposed || (this.remote && snapshot.revision < this.remote.revision)) return;
    try {
      this.remote = snapshot;
      if (same(this.base, this.local)) this.base = this.local = structuredClone(snapshot.records);
      this.reconcile();
      void this.flush();
    } catch (error) { this.fail(error as Error); }
  }
  /** Only the user's actual changed fields enter the queue, not remote fields
   * already incorporated into the displayed gradebook. */
  edit(before: Records, after: Records) {
    if (this.disposed) return;
    const captured = mergeRecords(before, after, this.local);
    if (captured.conflicts.length) {
      // A remote update may have arrived while a field's draft was focused.
      // Preserve what the user actually saw as the expected value, rather than
      // treating their blur commit as consent to overwrite the unseen update.
      this.base = mergeRecords(after, before, this.base).records;
    }
    this.local = captured.records;
    try { this.reconcile(); void this.flush(); }
    catch (error) { this.fail(error as Error); }
  }
  resolve(choice: "local" | "remote") {
    if (!this.remote || !this.state.conflicts.length) return;
    this.local = mergeRecords(this.base, this.local, this.remote.records, choice).records;
    this.base = structuredClone(this.remote.records);
    try { this.reconcile(); void this.flush(); }
    catch (error) { this.fail(error as Error); }
  }
  async retry() {
    if (this.disposed) return;
    try {
      this.receive(await this.transport.refresh());
      if (!this.disposed && this.watchFailed) { this.unsubscribe?.(); this.watch(); }
    }
    catch (error) { this.fail(error as Error); }
  }
  private async flush() {
    if (this.pumping || this.disposed || !this.remote || this.state.conflicts.length || this.state.status === "error") return;
    this.pumping = true;
    let staleRetries = 0;
    try {
      while (!this.disposed && this.remote && !this.state.conflicts.length) {
        const expected = structuredClone(this.remote);
        const sentLocal = structuredClone(this.local);
        const merged = mergeRecords(this.base, sentLocal, expected.records);
        if (merged.conflicts.length || same(merged.records, expected.records)) break;
        this.persist(this.getCache());
        try {
          const committed = await this.transport.commit(expected, merged.records);
          if (this.disposed) return;
          // Edits made during the network request remain queued. The ack must
          // never replace those edits with the older request's snapshot.
          this.local = mergeRecords(sentLocal, this.local, committed.records).records;
          this.base = structuredClone(committed.records);
          if (!this.remote || committed.revision >= this.remote.revision) this.remote = committed;
          this.reconcile();
          staleRetries = 0;
        } catch (error) {
          if (error instanceof StaleSnapshot && staleRetries++ < 3) {
            this.receive(await this.transport.refresh());
            continue;
          }
          throw error;
        }
      }
    } catch (error) { if (!this.disposed) this.fail(error as Error); }
    finally { this.pumping = false; }
  }
}
