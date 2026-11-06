"use client";

import { useEffect, useRef } from "react";

type Destination = "library" | "discover" | "recent" | "offline" | "new";
type Item = { id: Destination | "admin"; label: string; path: string; href?: string };

const icons = {
  library: "M8 3h12v12H8zM4 7v13h12M12.5 6.5v5l4-2.5z",
  discover: "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z",
  recent: "M12 8v5l3 2M3 12a9 9 0 1 0 3-6M3 3v6h6",
  offline: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  new: "M4 5h16v15H4zM8 2v6M16 2v6M4 10h16M12 13v5M9.5 15.5h5",
  admin: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
} as const;

/** Phone bottom bar: every destination in one row; scrolls only if the screen is too narrow. */
export default function MobileNavigation({ active, onNavigate, admin = false, online = true }: { active: string; onNavigate?: (id: Destination) => void; admin?: boolean; online?: boolean }) {
  const items = ([
    { id: "library", label: "Libraries", path: icons.library },
    { id: "discover", label: "Discover", path: icons.discover },
    { id: "recent", label: "Recent", path: icons.recent },
    { id: "offline", label: "Offline", path: icons.offline },
    { id: "new", label: "New", path: icons.new },
    ...(admin ? [{ id: "admin" as const, label: "Admin", path: icons.admin, href: "/admin?section=notifications" }] : []),
  ] as Item[]).filter(item => online || item.id === "offline");
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return <div className="mobile-navigation-shell">
    <nav ref={navRef} className="mobile-navigation" aria-label="Main navigation">
    {items.map(item => <a key={item.id} href={item.href ?? `/?section=${item.id}`} aria-current={active === item.id ? "page" : undefined} onClick={onNavigate && item.id !== "admin" ? e => { e.preventDefault(); onNavigate(item.id as Destination); } : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.path} /></svg><span>{item.label}</span>
    </a>)}
    </nav>
  </div>;
}
