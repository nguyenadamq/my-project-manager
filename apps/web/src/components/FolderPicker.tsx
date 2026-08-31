import { useCallback, useEffect, useState } from "react";
import type { BrowseResult } from "@pm/shared";
import { api } from "../api.js";

// Registering a project used to mean typing an absolute path exactly right, with no feedback
// until the server rejected it. This walks the allowed roots instead: every folder shown is one
// the server already agreed is in scope, and each is labelled with whether it's a Git
// repository and whether it's registered already -- so "Add this folder" is only ever offered
// for something that will actually work.
export function FolderPicker({ close, added, onError }: { close: () => void; added: () => void; onError: (message: string) => void }) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = useCallback((path: string | null) => {
    setError("");
    setResult(null);
    setCurrent(path);
    void api.browse(path ?? undefined).then(setResult).catch((cause: Error) => setError(cause.message));
  }, []);
  useEffect(() => open(null), [open]);

  // The folder you are standing in is registrable in its own right -- that is the common case:
  // you navigate into the repo, then add it. The server describes it alongside its children so
  // the button is only live when adding it would actually succeed.
  const currentEntry = result?.current ?? null;

  const add = async (target: string, label?: string) => {
    setBusy(true);
    try { await api.addProject(target, label?.trim() || undefined); added(); close(); }
    catch (cause) { const message = (cause as Error).message; setError(message); onError(message); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onClick={close}>
    <div className="modal picker" onClick={(event) => event.stopPropagation()}>
      <span className="eyebrow">Register repository</span>
      <h2>Pick a project folder</h2>
      <p className="muted">Only folders inside <code>PM_ALLOWED_ROOTS</code> are listed. Open a folder to go deeper; add the one holding the repository.</p>
      <div className="picker-bar">
        <button type="button" className="ghost" disabled={!current} onClick={() => open(result?.parent ?? null)}>↑ Up</button>
        <code className="picker-path">{current ?? "Allowed roots"}</code>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="picker-list">
        {!result && !error && <li className="muted">Loading…</li>}
        {result?.entries.map((entry) => <li key={entry.path}>
          <button type="button" className="picker-entry" onClick={() => open(entry.path)}>
            <span className="picker-name">{entry.name}</span>
            {entry.isGitRepo && <span className={`picker-tag ${entry.isRegistered ? "muted-tag" : "repo-tag"}`}>{entry.isRegistered ? "registered" : "git repo"}</span>}
          </button>
          {entry.isGitRepo && !entry.isRegistered && <button type="button" className="ghost tiny" disabled={busy} onClick={() => void add(entry.path)}>Add</button>}
        </li>)}
        {result && !result.entries.length && <li className="muted">No sub-folders here.</li>}
      </ul>
      <label>Name (optional)<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to the folder name"/></label>
      <div className="row">
        <button type="button" disabled={!currentEntry?.isGitRepo || currentEntry.isRegistered || busy} onClick={() => void add(current!, name)}>{busy ? "Adding…" : "Add this folder"}</button>
        <button type="button" className="ghost" onClick={close}>Cancel</button>
      </div>
      {currentEntry && !currentEntry.isGitRepo && <small className="muted">This folder isn't a Git repository — open the folder that holds one.</small>}
      {currentEntry?.isRegistered && <small className="muted">This folder is already registered.</small>}
    </div>
  </div>;
}
