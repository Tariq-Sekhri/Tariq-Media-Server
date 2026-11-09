"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useBackLayer } from "./lib/back-layers";
import MenuIcon from "./MenuIcon";

type Confirmation = { title: string; description: string; action: string; danger?: boolean };
type PendingConfirmation = Confirmation & { resolve: (accepted: boolean) => void };
type AppConfirm = (options: Confirmation) => Promise<boolean>;
const ConfirmationContext = createContext<AppConfirm | null>(null);

export function useAppConfirm() {
  const appConfirm = useContext(ConfirmationContext);
  if (!appConfirm) throw new Error("App confirmations require AppConfirmProvider");
  return appConfirm;
}

export default function AppConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const active = useRef<PendingConfirmation | null>(null);
  const queue = useRef<PendingConfirmation[]>([]);
  const appConfirm = useCallback<AppConfirm>((options) => new Promise((resolve) => {
    const next = { ...options, resolve };
    if (active.current) queue.current.push(next);
    else { active.current = next; setPending(next); }
  }), []);
  const finish = useCallback((accepted: boolean) => {
    const previous = active.current;
    active.current = queue.current.shift() ?? null;
    setPending(active.current);
    previous?.resolve(accepted);
  }, []);
  useBackLayer(Boolean(pending), () => finish(false));
  useEffect(() => () => {
    active.current?.resolve(false);
    queue.current.forEach((entry) => entry.resolve(false));
    active.current = null;
    queue.current = [];
  }, []);

  return <ConfirmationContext.Provider value={appConfirm}>
    {children}
    {pending && <div className="app-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(false); }}>
      <section className="app-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title" aria-describedby="app-confirm-description" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
      }}>
        <header><h2 id="app-confirm-title">{pending.title}</h2><button type="button" className="app-confirm-close" aria-label="Close confirmation" onClick={() => finish(false)}><MenuIcon name="close" /></button></header>
        <p id="app-confirm-description">{pending.description}</p>
        <footer><button type="button" onClick={() => finish(false)}>Cancel</button><button type="button" className={pending.danger ? "danger" : "primary"} onClick={() => finish(true)}>{pending.action}</button></footer>
      </section>
    </div>}
  </ConfirmationContext.Provider>;
}
