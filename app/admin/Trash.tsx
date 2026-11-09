"use client";

import { useCallback, useEffect, useState } from "react";
import AdminLoading from "./AdminLoading";
import { useAppConfirm } from "../AppConfirmProvider";
import { authFetch } from "../lib/auth";
import { API_BASE, formatBytes } from "../lib/media";

type TrashEntry = { id: string; original_path: string; stored_name: string; name: string; kind: "file" | "folder"; size: number; deleted_at: number };

export default function AdminTrash() {
  const appConfirm = useAppConfirm();
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await authFetch(`${API_BASE}/api/trash`);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setEntries((await response.json() as TrashEntry[]).sort((a, b) => b.deleted_at - a.deleted_at));
    } catch (error) {
      setEntries((current) => current ?? []);
      setMessage(error instanceof Error ? `Could not load Trash: ${error.message}` : "Could not load Trash");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run = async (key: string, request: () => Promise<Response>, done: string, remove: (entry: TrashEntry) => boolean) => {
    setBusy(key);
    setMessage("");
    try {
      const response = await request();
      if (response.status === 409) throw new Error("The original location is already occupied");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setEntries((current) => current?.filter((entry) => !remove(entry)) ?? current);
      setMessage(done);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
      void load();
    } finally {
      setBusy("");
    }
  };
  const restore = (entry: TrashEntry) => run(entry.id, () => authFetch(`${API_BASE}/api/trash/${encodeURIComponent(entry.id)}/restore`, { method: "POST" }), `Restored ${entry.name}`, (candidate) => candidate.id === entry.id);
  const remove = async (entry: TrashEntry) => {
    if (!await appConfirm({ title: "Delete forever?", description: `Permanently delete ${entry.name}? This cannot be undone.`, action: "Delete forever", danger: true })) return;
    await run(entry.id, () => authFetch(`${API_BASE}/api/trash/${encodeURIComponent(entry.id)}`, { method: "DELETE" }), `Permanently deleted ${entry.name}`, (candidate) => candidate.id === entry.id);
  };
  const empty = async () => {
    if (!entries?.length || !await appConfirm({ title: "Empty Trash?", description: `Permanently delete all ${entries.length} item${entries.length === 1 ? "" : "s"} in Trash? This cannot be undone.`, action: "Empty Trash", danger: true })) return;
    await run("empty", () => authFetch(`${API_BASE}/api/trash`, { method: "DELETE" }), "Trash emptied", () => true);
  };
  const total = entries?.reduce((sum, entry) => sum + entry.size, 0) ?? 0;

  return <article className="admin-surface admin-section-surface admin-trash-surface">
    <header>
      <div><h2>{entries ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : "Trash"}</h2>{entries && entries.length > 0 && <span>{formatBytes(total)}</span>}</div>
      {entries && entries.length > 0 && <button type="button" className="admin-danger-action" disabled={Boolean(busy)} onClick={() => void empty()}>{busy === "empty" ? "Emptying…" : "Empty Trash"}</button>}
    </header>
    {message && <p className="admin-trash-message" role="status">{message}</p>}
    {!entries ? <AdminLoading label="Loading Trash" />
      : !entries.length ? <div className="admin-panel-empty"><span>♲</span><b>Trash is empty</b></div>
        : <ul className="admin-trash-list">{entries.map((entry) => <li key={entry.id}>
          <span aria-hidden="true">{entry.kind === "folder" ? "▣" : "▤"}</span>
          <div><b>{entry.name}</b><small>{entry.original_path} · {formatBytes(entry.size)} · Deleted {new Date(entry.deleted_at * 1000).toLocaleString()}</small></div>
          <button type="button" disabled={Boolean(busy)} onClick={() => void restore(entry)}>{busy === entry.id ? "Working…" : "Restore"}</button>
          <button type="button" className="admin-danger-action" disabled={Boolean(busy)} onClick={() => void remove(entry)}>Delete forever</button>
        </li>)}</ul>}
  </article>;
}
