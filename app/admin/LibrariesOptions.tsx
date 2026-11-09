"use client";

import { useEffect, useState } from "react";

/**
 * Candidate layouts for Admin → Libraries. Option 1 is the chosen side-by-side layout;
 * option 2 is the tabs-and-table alternative. Every option edits the same library
 * drafts through the same handlers, so switching layouts never loses or resaves work.
 * Once one wins, delete the others and the picker.
 */

type ContentType = "mixed" | "movies_tv" | "music" | "files";
type Member = { name: string; can_view: boolean; can_delete: boolean; can_move: boolean; can_create_folders: boolean; can_upload: boolean; can_download: boolean; can_rename: boolean };
type Library = { content_type: ContentType; members: Member[]; title_folders: string[]; trickplay_enabled: boolean; folder_structure_static: boolean };
type PermissionKey = keyof Omit<Member, "name">;
type Preset = "none" | "viewer" | "user" | "editor" | "manager";
type User = { name: string; is_admin: boolean };

export type LibrariesLayout = 1 | 2;

export const LIBRARIES_LAYOUTS: readonly { id: LibrariesLayout; hint: string }[] = [
  { id: 1, hint: "Library list beside settings and access, access levels as buttons" },
  { id: 2, hint: "Libraries as tabs, access as a person × permission table" },
];

const KEY = "tms.admin.librariesLayout";
const listeners = new Set<(layout: LibrariesLayout) => void>();

function storedLayout(): LibrariesLayout {
  try {
    const saved = Number(window.localStorage.getItem(KEY));
    return LIBRARIES_LAYOUTS.some((layout) => layout.id === saved) ? saved as LibrariesLayout : 1;
  } catch {
    return 1;
  }
}

/** The selected layout, shared by the picker and the section, remembered in this browser. */
export function useLibrariesLayout(): [LibrariesLayout, (layout: LibrariesLayout) => void] {
  const [layout, setLayout] = useState<LibrariesLayout>(1);
  useEffect(() => {
    listeners.add(setLayout);
    const timer = window.setTimeout(() => setLayout(storedLayout()), 0);
    return () => { window.clearTimeout(timer); listeners.delete(setLayout); };
  }, []);
  return [layout, (next) => {
    try { window.localStorage.setItem(KEY, String(next)); } catch { /* per-browser convenience only */ }
    listeners.forEach((listener) => listener(next));
  }];
}

/** Admin-only switch between the candidate layouts, styled after Bramble's dev picker. */
export function LibrariesLayoutPicker({ layout, onChange }: { layout: LibrariesLayout; onChange: (layout: LibrariesLayout) => void }) {
  return <div className="ui-option-picker" title="Compare Libraries layouts">
    <span>Layout</span>
    <div className="ui-option-seg" role="radiogroup" aria-label="Libraries layout">
      {LIBRARIES_LAYOUTS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={layout === option.id} className={layout === option.id ? "on" : undefined} title={option.hint} onClick={() => onChange(option.id)}>{option.id}</button>)}
    </div>
  </div>;
}

export type LibrariesOptionProps = {
  layout: LibrariesLayout;
  libraries: Record<string, Library>;
  users: User[];
  types: { value: ContentType; label: string }[];
  permissions: { key: PermissionKey; label: string; description: string }[];
  presetOf: (member: Member | undefined) => Preset;
  presetLabel: (preset: Preset) => string;
  update: (path: string, update: (library: Library) => Library) => void;
  setPreset: (path: string, name: string, preset: Preset) => void;
  setPermission: (path: string, name: string, permission: PermissionKey, enabled: boolean) => void;
  runTrickplay: (path: string) => void;
  trickplayAction: string;
  savingLibrary: string;
  savedLibrary: string;
};

const PRESETS: Preset[] = ["none", "viewer", "user", "editor", "manager"];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export default function LibrariesOptions(props: LibrariesOptionProps) {
  const paths = Object.keys(props.libraries);
  const names = [...new Set([...props.users.map((user) => user.name), ...paths.flatMap((path) => props.libraries[path].members.map((member) => member.name))])].sort((a, b) => a.localeCompare(b));
  const isAdmin = (name: string) => Boolean(props.users.find((user) => same(user.name, name))?.is_admin);
  const memberOf = (path: string, name: string) => props.libraries[path].members.find((member) => same(member.name, name));
  const typeLabel = (type: ContentType) => props.types.find((option) => option.value === type)?.label ?? type;
  const status = (path: string) => props.savingLibrary === path ? "Saving…" : props.savedLibrary === path ? "Saved" : "";
  const ctx = { ...props, paths, names, isAdmin, memberOf, typeLabel, status };
  if (props.layout === 2) return <TabsTable {...ctx} />;
  return <SideBySide {...ctx} />;
}

type Ctx = LibrariesOptionProps & {
  paths: string[];
  names: string[];
  isAdmin: (name: string) => boolean;
  memberOf: (path: string, name: string) => Member | undefined;
  typeLabel: (type: ContentType) => string;
  status: (path: string) => string;
};

const openLibrary = (path: string) => window.location.assign(`/?folder=${encodeURIComponent(path)}`);

function TypeSelect({ ctx, path }: { ctx: Ctx; path: string }) {
  return <select aria-label={`Library type for ${path}`} value={ctx.libraries[path].content_type} onChange={(event) => ctx.update(path, (library) => ({ ...library, content_type: event.target.value as ContentType }))}>
    {ctx.types.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
  </select>;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="lib-opt-switch"><input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function LibrarySettings({ ctx, path }: { ctx: Ctx; path: string }) {
  const library = ctx.libraries[path];
  return <div className="lib-opt-settings">
    <label className="lib-opt-field"><span>Type</span><TypeSelect ctx={ctx} path={path} /></label>
    <Switch label="Static folders" checked={library.folder_structure_static} onChange={(checked) => ctx.update(path, (current) => ({ ...current, folder_structure_static: checked }))} />
    <Switch label="Timeline previews" checked={library.trickplay_enabled} onChange={(checked) => ctx.update(path, (current) => ({ ...current, trickplay_enabled: checked }))} />
    {library.trickplay_enabled && <button type="button" className="lib-opt-ghost" disabled={ctx.trickplayAction === path} onClick={() => ctx.runTrickplay(path)}>{ctx.trickplayAction === path ? "Queuing…" : "Generate previews"}</button>}
  </div>;
}

function PresetSelect({ ctx, path, name }: { ctx: Ctx; path: string; name: string }) {
  if (ctx.isAdmin(name)) return <span className="lib-opt-admin">Full access</span>;
  const preset = ctx.presetOf(ctx.memberOf(path, name));
  return <select className={`lib-opt-preset is-${preset}`} aria-label={`${name} access to ${path}`} value={preset} onChange={(event) => ctx.setPreset(path, name, event.target.value as Preset)}>
    {PRESETS.map((value) => <option key={value} value={value}>{ctx.presetLabel(value)}</option>)}
  </select>;
}

function PermissionChips({ ctx, path, name }: { ctx: Ctx; path: string; name: string }) {
  const member = ctx.memberOf(path, name);
  if (ctx.isAdmin(name) || !member?.can_view) return null;
  return <div className="lib-opt-chips">{ctx.permissions.map((permission) => <button key={permission.key} type="button" title={permission.description} aria-pressed={Boolean(member[permission.key])} className={member[permission.key] ? "on" : undefined} onClick={() => ctx.setPermission(path, name, permission.key, !member[permission.key])}>{permission.label}</button>)}</div>;
}

const SELECTED_KEY = "tms.admin.selectedLibrary";

/** The library open in the detail pane, shared by every layout and remembered in this browser. */
function useSelectedLibrary(ctx: Ctx): [string, (path: string) => void] {
  const [selected, setSelected] = useState(() => {
    try { return window.localStorage.getItem(SELECTED_KEY) ?? ""; } catch { return ""; }
  });
  const path = ctx.libraries[selected] ? selected : ctx.paths[0];
  return [path, (next) => {
    try { window.localStorage.setItem(SELECTED_KEY, next); } catch { /* per-browser convenience only */ }
    setSelected(next);
  }];
}

function LibraryIndex({ ctx, path, onSelect, rich }: { ctx: Ctx; path: string; onSelect: (path: string) => void; rich?: boolean }) {
  return <nav className="admin-surface lib-opt-index" aria-label="Libraries">{ctx.paths.map((candidate) => {
    const item = ctx.libraries[candidate];
    return <button key={candidate} type="button" className={candidate === path ? "active" : undefined} aria-current={candidate === path ? "true" : undefined} onClick={() => onSelect(candidate)}>
      <b>{candidate}</b><small>{ctx.typeLabel(item.content_type)} · {item.members.length} {item.members.length === 1 ? "person" : "people"}</small>
      {rich && (item.folder_structure_static || item.trickplay_enabled) && <span className="lib-opt-flags">{item.folder_structure_static && <em>Static</em>}{item.trickplay_enabled && <em>Previews</em>}</span>}
    </button>;
  })}</nav>;
}

function DetailHeader({ ctx, path }: { ctx: Ctx; path: string }) {
  return <header><h2><button type="button" className="lib-opt-title" onClick={() => openLibrary(path)}>{path}</button></h2>{ctx.status(path) && <span role="status">{ctx.status(path)}</span>}</header>;
}

function PresetButtons({ ctx, path, name }: { ctx: Ctx; path: string; name: string }) {
  if (ctx.isAdmin(name)) return <span className="lib-opt-admin">Full access</span>;
  const preset = ctx.presetOf(ctx.memberOf(path, name));
  return <div className="lib-opt-seg" role="radiogroup" aria-label={`${name} access to ${path}`}>{PRESETS.map((value) => <button key={value} type="button" role="radio" aria-checked={preset === value} className={preset === value ? `on is-${value}` : undefined} onClick={() => ctx.setPreset(path, name, value)}>{ctx.presetLabel(value)}</button>)}</div>;
}

const Avatar = ({ name }: { name: string }) => <span className="lib-opt-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>;

/* Option 1: settings and access side by side in the detail; access levels as buttons, permissions behind Customize. */
function SideBySide(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  const [custom, setCustom] = useState<string | null>(null);
  const library = ctx.libraries[path];
  return <div className="lib-opt-split">
    <LibraryIndex ctx={ctx} path={path} onSelect={select} rich />
    <article className="admin-surface lib-opt-detail">
      <DetailHeader ctx={ctx} path={path} />
      <div className="lib-opt-columns">
        <section className="lib-opt-stack">
          <h3>Settings</h3>
          <label className="lib-opt-field is-stacked"><span>Type</span><TypeSelect ctx={ctx} path={path} /></label>
          <Switch label="Static folders" checked={library.folder_structure_static} onChange={(checked) => ctx.update(path, (current) => ({ ...current, folder_structure_static: checked }))} />
          <Switch label="Timeline previews" checked={library.trickplay_enabled} onChange={(checked) => ctx.update(path, (current) => ({ ...current, trickplay_enabled: checked }))} />
          {library.trickplay_enabled && <button type="button" className="lib-opt-ghost" disabled={ctx.trickplayAction === path} onClick={() => ctx.runTrickplay(path)}>{ctx.trickplayAction === path ? "Queuing…" : "Generate previews"}</button>}
        </section>
        <section>
          <h3>Access <small>{library.members.length} enabled</small></h3>
          <ul className="lib-opt-access is-buttons">{ctx.names.map((name) => {
            const enabled = !ctx.isAdmin(name) && Boolean(ctx.memberOf(path, name)?.can_view);
            const key = `${path}\n${name}`;
            return <li key={name}>
              <Avatar name={name} />
              <b>{name}</b>
              <PresetButtons ctx={ctx} path={path} name={name} />
              {enabled ? <button type="button" className="lib-opt-link" aria-expanded={custom === key} onClick={() => setCustom(custom === key ? null : key)}>Customize</button> : <span />}
              {custom === key && enabled && <PermissionChips ctx={ctx} path={path} name={name} />}
            </li>;
          })}</ul>
        </section>
      </div>
    </article>
  </div>;
}

/* Option 2: libraries as tabs above one panel; access as a person × permission table. */
const PERMISSION_ORDER: { key: PermissionKey; short: string }[] = [
  { key: "can_view", short: "View" },
  { key: "can_upload", short: "Upload" },
  { key: "can_download", short: "Downloads" },
  { key: "can_create_folders", short: "Folders" },
  { key: "can_move", short: "Move" },
  { key: "can_rename", short: "Rename" },
  { key: "can_delete", short: "Delete" },
];

function TabsTable(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  const library = ctx.libraries[path];
  const describe = (key: PermissionKey) => ctx.permissions.find((permission) => permission.key === key);
  return <div className="lib-tabs">
    <nav className="lib-tabs-bar" role="tablist" aria-label="Libraries">{ctx.paths.map((candidate) => {
      const item = ctx.libraries[candidate];
      return <button key={candidate} type="button" role="tab" aria-selected={candidate === path} className={candidate === path ? "active" : undefined} onClick={() => select(candidate)}>
        <b>{candidate}</b><small>{ctx.typeLabel(item.content_type)} · {item.members.length}</small>
      </button>;
    })}</nav>
    <article className="admin-surface lib-tabs-panel" role="tabpanel" aria-label={path}>
      <header>
        <h2><button type="button" className="lib-opt-title" onClick={() => openLibrary(path)}>{path}</button></h2>
        {ctx.status(path) && <span role="status">{ctx.status(path)}</span>}
        <LibrarySettings ctx={ctx} path={path} />
      </header>
      <div className="lib-tabs-scroll"><table className="lib-tabs-table">
        <thead>
          <tr><th rowSpan={2} className="lib-tabs-person">Person <small>{library.members.length} with access</small></th><th rowSpan={2}>Access</th><th colSpan={PERMISSION_ORDER.length} className="lib-tabs-group">Permissions</th></tr>
          <tr>{PERMISSION_ORDER.map((permission) => <th key={permission.key} title={describe(permission.key)?.description}>{permission.short}</th>)}</tr>
        </thead>
        <tbody>{ctx.names.map((name) => {
          const member = ctx.memberOf(path, name);
          const admin = ctx.isAdmin(name);
          const preset = ctx.presetOf(member);
          return <tr key={name} className={admin ? "is-admin" : preset === "none" ? "is-none" : undefined}>
            <th scope="row" className="lib-tabs-person"><span className="lib-opt-person-cell"><Avatar name={name} /><span><b>{name}</b><small>{admin ? "Administrator" : ctx.presetLabel(preset)}</small></span></span></th>
            {admin ? <td colSpan={PERMISSION_ORDER.length + 1} className="lib-tabs-note">Full access to every library</td> : <>
              <td><PresetSelect ctx={ctx} path={path} name={name} /></td>
              {preset === "none" ? <td colSpan={PERMISSION_ORDER.length} className="lib-tabs-note">No access</td>
                : PERMISSION_ORDER.map((permission) => {
                  const on = Boolean(member?.[permission.key]);
                  const label = describe(permission.key)?.label ?? permission.short;
                  return <td key={permission.key}><button type="button" className={`lib-tabs-toggle${on ? " on" : ""}`} aria-pressed={on} aria-label={`${name}: ${label} in ${path}`} title={label} onClick={() => ctx.setPermission(path, name, permission.key, !on)}>{on ? "✓" : ""}</button></td>;
                })}
            </>}
          </tr>;
        })}</tbody>
      </table></div>
    </article>
  </div>;
}
