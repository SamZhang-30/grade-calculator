import { useState } from "react";
import { DialogSurface } from "./DialogSurface";
import { chooseData, connectGoogle, disconnectSync, resolveConflicts, retrySync, type SyncState } from "../sync/client";

export function syncLabel(state: SyncState): string {
  if (state.phase === "local") return "Local only";
  if (state.phase === "choose") return "Choose data";
  if (state.phase === "loading") return "Connecting…";
  if (state.phase === "error" || state.error || state.engine?.status === "error") return "Needs attention";
  if (state.engine?.conflicts.length) return "Resolve conflicts";
  if (state.engine?.status === "synced") return "Up to date";
  return state.engine?.pending ? `${state.engine.pending} queued` : "Connecting…";
}

export function CloudIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15h10a3.5 3.5 0 0 0 .3-7 5.5 5.5 0 0 0-10.5-1A4 4 0 0 0 5 15Z" /></svg>;
}

export function SyncDialog({ state, onClose }: { state: SyncState; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  const queued = !!state.engine?.pending || !!state.engine?.conflicts.length;
  const error = state.error || state.engine?.error;
  const conflicts = state.engine?.conflicts ?? [];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <DialogSurface className="settings-dialog sync-dialog" aria-labelledby="sync-title" onClose={onClose}>
        <div className="dialog-head">
          <div><p className="eyebrow">Across devices</p><h2 id="sync-title">Cloud sync</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close cloud sync">×</button>
        </div>
        <p className="dialog-intro">Everyone can use this calculator without an account. Your edits are saved in this browser. Cloud sync is currently available only to the site owner’s verified Google account.</p>
        {!state.configured ? (
          <div className="sync-setup">
            <p>Cloud sync hasn’t been configured for this site yet. Your data is still saved only in this browser.</p>
            <details><summary>Site owner: setup instructions</summary><ol>
              <li>Create a <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">Firebase project</a> and register a web app.</li>
              <li>Enable Google sign-in, create Firestore in production mode, and publish the owner-only rules from <code>firestore.rules</code> in the repository.</li>
              <li>Authorize your GitHub Pages domain and localhost in Authentication.</li>
              <li>Set the four <code>VITE_FIREBASE_*</code> build variables listed in <code>.env.example</code>, then rebuild and redeploy.</li>
            </ol>
            <p className="sync-hint">Full instructions are in <code>docs/cloud-sync.md</code>. The Firebase web config is public; never paste a service-account key into this app.</p></details>
          </div>
        ) : !state.account ? (
          <div className="sync-section">
            <p>No account connected. Signing in won’t upload anything until you choose which data to use.</p>
            <button className="primary-button" disabled={busy || state.phase === "loading"} onClick={() => void run(connectGoogle)}>Sign in with Google</button>
            <p className="sync-hint">Cloud sync is currently restricted to the owner’s verified Google account. Allow the sign-in popup if your browser blocks it.</p>
          </div>
        ) : (
          <>
            <div className="sync-account"><span><b>{state.account?.email ?? "Google account"}</b><small>{syncLabel(state)}</small></span>
              <button className="secondary-button" disabled={busy} onClick={() => {
                if (queued) setConfirmDisconnect(true);
                else void run(disconnectSync);
              }}>Sign out</button>
            </div>
            {state.phase === "loading" ? <p role="status">Checking your account…</p> : null}
            {state.phase === "choose" ? (
              <div className="sync-section">
                <h3>{state.cloudExists ? "A cloud gradebook already exists" : "Set up this account"}</h3>
                <p>{state.cloudExists
                  ? "Use the account’s gradebook, or add copies of this device’s classes and GPA terms. Adding copies keeps the account’s global defaults and may create duplicates. Your original local-only data stays on this device."
                  : "Upload this device’s gradebook to start syncing. Your original local-only data stays on this device."}</p>
                <div className="sync-buttons">
                  {state.cloudExists ? <>
                    <button className="primary-button" disabled={busy} onClick={() => void run(() => chooseData("cloud"))}>Use cloud gradebook</button>
                    <button className="secondary-button" disabled={busy} onClick={() => void run(() => chooseData("merge"))}>Add this device’s classes</button>
                  </> : <button className="primary-button" disabled={busy} onClick={() => void run(() => chooseData("local"))}>Upload this device’s gradebook</button>}
                </div>
              </div>
            ) : null}
            {state.phase === "connected" && !conflicts.length ? <p className="sync-hint">
              {state.engine?.status === "synced" ? "Changes are synced. Other signed-in devices update automatically." : "Edits are saved on this device first. Queued changes sync automatically when a connection is available."}
              {" "}Undo and redo affect your edits, not unrelated changes made on another device.
            </p> : null}
            {conflicts.length ? <div className="sync-section">
              <h3>Changes need your choice</h3>
              <p>Both devices changed these fields, or one deleted a record the other edited. Sync is paused. The choices below apply to all listed conflicts; unrelated changes are kept.</p>
              <ul className="sync-conflicts">{conflicts.map((conflict) => <li key={`${conflict.key}:${conflict.field}`}>
                <b>{conflict.label} · {conflict.field}</b>
                <small>This device: {JSON.stringify(conflict.local)}</small>
                <small>Cloud: {JSON.stringify(conflict.remote)}</small>
              </li>)}</ul>
              <div className="sync-buttons">
                <button className="primary-button" onClick={() => resolveConflicts("local")}>Keep this device’s versions</button>
                <button className="secondary-button" onClick={() => resolveConflicts("remote")}>Use cloud versions</button>
              </div>
            </div> : null}
            {confirmDisconnect ? <div className="sync-section">
              <p>Some edits haven’t synced. They’ll stay in this account’s browser cache and resume when you sign back in here. Signing out returns to your separate local-only gradebook.</p>
              <div className="sync-buttons">
                <button className="secondary-button" onClick={() => setConfirmDisconnect(false)}>Stay connected</button>
                <button className="danger-button" disabled={busy} onClick={() => void run(disconnectSync)}>Sign out anyway</button>
              </div>
            </div> : null}
          </>
        )}
        {error ? <div className="sync-error" role="alert"><p>{error}</p>
          {state.configured && state.phase !== "local" ? <button className="secondary-button" disabled={busy} onClick={() => void run(retrySync)}>Retry sync</button> : null}
        </div> : null}
        <p className="sync-hint">Cloud sync saves the latest state, not past versions. Undo/redo changes sync like any other edit. Use Backups & data for recovery after a reload. Account data stays cached after sign-out; use a trusted device.</p>
        <div className="dialog-footer"><span>{state.phase === "connected" ? "Account data is cached on this device." : "Your local gradebook is unchanged."}</span>
          <button className="primary-button" autoFocus onClick={onClose}>Done</button></div>
      </DialogSurface>
    </div>
  );
}
