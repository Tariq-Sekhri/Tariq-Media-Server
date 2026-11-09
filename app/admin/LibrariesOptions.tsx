"use client";

import { useEffect, useState } from "react";

/**
 * Candidate layouts for Admin → Libraries. Option 1 is the original layout, rendered by
 * the admin page itself; options 2-5 live here. Every option edits the same library
 * drafts through the same handlers, so switching layouts never loses or resaves work.
 * Once one wins, delete the others and the picker.
 */

type ContentType = "mixed" | "movies_tv" | "music" | "files";
type Member = { name: string; can_view: boolean; can_delete: boolean; can_move: boolean; can_create_folders: boolean; can_upload: boolean; can_download: boolean; can_rename: boolean };
type Library = { content_type: ContentType; members: Member[]; title_folders: string[]; trickplay_enabled: boolean; folder_structure_static: boolean };
type PermissionKey = keyof Omit<Member, "name">;
type Preset = "none" | "viewer" | "user" | "editor" | "manager";
type User = { name: string; is_admin: boolean };

export type LibrariesLayout = 1 | 2 | 3 | 4 | 5;

export const LIBRARIES_LAYOUTS: readonly { id: LibrariesLayout; hint: string }[] = [
  { id: 1, hint: "The original: one large card per library" },
  { id: 2, hint: "Library list on the left, the selected library on the right" },
  { id: 3, hint: "Tables: library settings, then a people × libraries access grid" },
  { id: 4, hint: "One compact row per library that expands to edit" },
  { id: 5, hint: "Pick a person and set their access to every library" },
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
  layout: Exclude<LibrariesLayout, 1>;
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
  if (props.layout === 2) return <MasterDetail {...ctx} />;
  if (props.layout === 3) return <Tables {...ctx} />;
  if (props.layout === 4) return <Rows {...ctx} />;
  return <ByPerson {...ctx} />;
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

function AccessList({ ctx, path, chips }: { ctx: Ctx; path: string; chips: boolean }) {
  return <ul className="lib-opt-access">{ctx.names.map((name) => <li key={name}>
    <span className="lib-opt-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
    <b>{name}</b>
    <PresetSelect ctx={ctx} path={path} name={name} />
    {chips && <PermissionChips ctx={ctx} path={path} name={name} />}
  </li>)}</ul>;
}

/* Option 2: list of libraries beside the selected library. */
function MasterDetail(ctx: Ctx) {
  const [selected, setSelected] = useState(ctx.paths[0] ?? "");
  const path = ctx.libraries[selected] ? selected : ctx.paths[0];
  const library = ctx.libraries[path];
  return <div className="lib-opt-split">
    <nav className="admin-surface lib-opt-index" aria-label="Libraries">{ctx.paths.map((candidate) => {
      const item = ctx.libraries[candidate];
      return <button key={candidate} type="button" className={candidate === path ? "active" : undefined} aria-current={candidate === path ? "true" : undefined} onClick={() => setSelected(candidate)}>
        <b>{candidate}</b><small>{ctx.typeLabel(item.content_type)} · {item.members.length} {item.members.length === 1 ? "person" : "people"}</small>
      </button>;
    })}</nav>
    <article className="admin-surface lib-opt-detail">
      <header><h2><button type="button" className="lib-opt-title" onClick={() => openLibrary(path)}>{path}</button></h2>{ctx.status(path) && <span role="status">{ctx.status(path)}</span>}</header>
      <LibrarySettings ctx={ctx} path={path} />
      <h3>Access <small>{library.members.length} enabled</small></h3>
      <AccessList ctx={ctx} path={path} chips />
    </article>
  </div>;
}

/* Option 3: one settings table and one people × libraries grid. */
function Tables(ctx: Ctx) {
  return <div className="lib-opt-tables">
    <article className="admin-surface lib-opt-table-card">
      <h2>Libraries</h2>
      <div className="lib-opt-scroll"><table className="lib-opt-table">
        <thead><tr><th>Library</th><th>Type</th><th>Static folders</th><th>Timeline previews</th><th>People</th><th /></tr></thead>
        <tbody>{ctx.paths.map((path) => {
          const library = ctx.libraries[path];
          return <tr key={path}>
            <th scope="row"><button type="button" className="lib-opt-title" onClick={() => openLibrary(path)}>{path}</button>{ctx.status(path) && <small role="status">{ctx.status(path)}</small>}</th>
            <td><TypeSelect ctx={ctx} path={path} /></td>
            <td><input type="checkbox" aria-label={`Static folders for ${path}`} checked={library.folder_structure_static} onChange={(event) => ctx.update(path, (current) => ({ ...current, folder_structure_static: event.target.checked }))} /></td>
            <td><input type="checkbox" aria-label={`Timeline previews for ${path}`} checked={library.trickplay_enabled} onChange={(event) => ctx.update(path, (current) => ({ ...current, trickplay_enabled: event.target.checked }))} /></td>
            <td>{library.members.length}</td>
            <td>{library.trickplay_enabled && <button type="button" className="lib-opt-ghost" disabled={ctx.trickplayAction === path} onClick={() => ctx.runTrickplay(path)}>{ctx.trickplayAction === path ? "Queuing…" : "Generate"}</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </article>
    <article className="admin-surface lib-opt-table-card">
      <h2>Access</h2>
      <div className="lib-opt-scroll"><table className="lib-opt-table lib-opt-grid">
        <thead><tr><th>Person</th>{ctx.paths.map((path) => <th key={path}>{path}</th>)}</tr></thead>
        <tbody>{ctx.names.map((name) => <tr key={name}>
          <th scope="row"><span className="lib-opt-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>{name}</th>
          {ctx.paths.map((path) => <td key={path}><PresetSelect ctx={ctx} path={path} name={name} /></td>)}
        </tr>)}</tbody>
      </table></div>
    </article>
  </div>;
}

/* Option 4: compact rows that expand in place. */
function Rows(ctx: Ctx) {
  const [open, setOpen] = useState<string | null>(null);
  return <div className="admin-surface lib-opt-rows">{ctx.paths.map((path) => {
    const library = ctx.libraries[path];
    const expanded = open === path;
    const people = ctx.names.filter((name) => ctx.isAdmin(name) || ctx.memberOf(path, name)?.can_view);
    return <section key={path} className={expanded ? "expanded" : undefined}>
      <button type="button" className="lib-opt-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : path)}>
        <span className="lib-opt-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <b>{path}</b>
        <span>{ctx.typeLabel(library.content_type)}</span>
        <span className="lib-opt-people">{people.slice(0, 5).map((name) => <i key={name} title={name}>{name.slice(0, 2).toUpperCase()}</i>)}{people.length > 5 && <i>+{people.length - 5}</i>}</span>
        <span className="lib-opt-flags">{library.folder_structure_static && <em>Static</em>}{library.trickplay_enabled && <em>Previews</em>}</span>
        {ctx.status(path) && <small role="status">{ctx.status(path)}</small>}
      </button>
      {expanded && <div className="lib-opt-row-body">
        <LibrarySettings ctx={ctx} path={path} />
        <AccessList ctx={ctx} path={path} chips />
        <button type="button" className="lib-opt-ghost" onClick={() => openLibrary(path)}>Open library</button>
      </div>}
    </section>;
  })}</div>;
}

/* Option 5: choose a person, then set their access to every library. */
function ByPerson(ctx: Ctx) {
  const [person, setPerson] = useState(ctx.names.find((name) => !ctx.isAdmin(name)) ?? ctx.names[0] ?? "");
  return <div className="lib-opt-person">
    <article className="admin-surface lib-opt-cards">{ctx.paths.map((path) => <section key={path}>
      <header><button type="button" className="lib-opt-title" onClick={() => openLibrary(path)}>{path}</button>{ctx.status(path) && <small role="status">{ctx.status(path)}</small>}</header>
      <LibrarySettings ctx={ctx} path={path} />
    </section>)}</article>
    <article className="admin-surface lib-opt-person-access">
      <div className="lib-opt-people-tabs" role="tablist" aria-label="Person">{ctx.names.map((name) => <button key={name} type="button" role="tab" aria-selected={person === name} className={person === name ? "active" : undefined} onClick={() => setPerson(name)}><span className="lib-opt-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>{name}</button>)}</div>
      {person && <ul className="lib-opt-access">{ctx.paths.map((path) => <li key={path}>
        <span className="lib-opt-avatar is-library" aria-hidden="true">▣</span>
        <b>{path}</b>
        <PresetSelect ctx={ctx} path={path} name={person} />
        <PermissionChips ctx={ctx} path={path} name={person} />
      </li>)}</ul>}
    </article>
  </div>;
}
