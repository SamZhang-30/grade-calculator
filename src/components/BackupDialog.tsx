import { useRef, useState } from "react";
import { backupCounts, MAX_BACKUP_BYTES, parseBackup, serializeBackup } from "../backup";
import { loadData, store } from "../store";
import type { SyncState } from "../sync/client";
import { DialogSurface } from "./DialogSurface";

function downloadBackup(prefix = "gradebook-backup") {
  const text = serializeBackup(loadData());
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BackupDialog({ sync, onClose }: { sync: SyncState; onClose: () => void }) {
  const [candidate, setCandidate] = useState<ReturnType<typeof parseBackup> | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selection = useRef(0);
  const cloud = sync.phase === "connected";
  const blocked = sync.phase === "loading" || sync.phase === "choose" || !!sync.engine?.conflicts.length;
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : "The backup could not be processed.");
  const restore = async () => {
    if (!candidate || blocked || busy) return;
    setError(""); setMessage("");
    try {
      // Download the current state before the single undoable replacement.
      downloadBackup("gradebook-before-restore");
      const changed = await store.restoreBackup(candidate.data);
      setCandidate(null);
      setMessage(changed
        ? "Backup restored. A download of the previous gradebook was started first; verify that file was saved. You can also undo this restore during this session."
        : "This backup matches the current gradebook. Nothing was changed.");
    } catch (cause) { fail(cause); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <DialogSurface className="settings-dialog backup-dialog" aria-labelledby="backup-title" onClose={onClose}>
      <div className="dialog-head"><div><p className="eyebrow">Recovery</p><h2 id="backup-title">Backups & data</h2></div>
        <button className="icon-button" aria-label="Close backups" onClick={onClose}>×</button></div>
      <p className="dialog-intro">Save every class, assignment, GPA term, and global setting in one JSON file. Backups contain grades and notes: keep them private.</p>
      <div className="sync-section"><h3>Export this gradebook</h3>
        <p>{backupCounts(loadData())}</p>
        <p className="sync-hint">{cloud ? "Exports this account’s current data, including unsynced edits." : "Exports this browser’s currently displayed gradebook."} Sign-in credentials and undo history are not included.</p>
        <button className="primary-button" onClick={() => { try { downloadBackup(); } catch (cause) { fail(cause); } }}>Download whole-app backup</button>
      </div>
      <div className="sync-section"><h3>Restore a backup</h3>
        <label className="backup-file">Choose whole-app JSON backup<input type="file" accept=".json,application/json" disabled={blocked} onChange={(event) => {
          const file = event.target.files?.[0];
          const selected = ++selection.current;
          setCandidate(null); setError(""); setMessage(""); setBusy(!!file);
          if (!file) return;
          if (file.size > MAX_BACKUP_BYTES) { setError("Backups must be smaller than 10 MB."); setBusy(false); return; }
          void file.text().then((text) => { if (selected === selection.current) setCandidate(parseBackup(text)); })
            .catch((cause) => { if (selected === selection.current) fail(cause); })
            .finally(() => { if (selected === selection.current) setBusy(false); });
        }} /></label>
        {blocked ? <p role="status">Finish connecting or resolve cloud conflicts before restoring a backup.</p> : null}
        {candidate ? <div className="backup-confirm"><p>Backup from {new Date(candidate.exportedAt).toLocaleString()}</p><p>{backupCounts(candidate.data)}</p>
          <p>This replaces every class, GPA term, and global setting in the current gradebook. It does not merge them. Your current data will be downloaded first; allow the download before continuing.</p>
          {cloud ? <p><b>This replacement will sync to your other connected devices.</b></p> : null}
          <button className="danger-button" disabled={blocked || busy} onClick={() => void restore()}>Back up current data and replace gradebook</button>
        </div> : null}
      </div>
      <p className="sync-hint">Undo/redo is session-only (up to 100 edits). Cloud sync saves the latest state, not a version history. A downloaded backup remains usable after reloads.</p>
      {error ? <p className="sync-error" role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="dialog-footer"><span>Clearing browser data removes local saves and unsynced edits.</span><button className="primary-button" onClick={onClose}>Done</button></div>
    </DialogSurface>
  </div>;
}
