"use client";

import { useEffect, useState } from "react";

/**
 * Candidate layouts for Admin → Libraries. Option 1 is the chosen list-and-detail layout;
 * options 2-5 are variations of it. Every option edits the same library
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
  { id: 1, hint: "Library list on the left, the selected library on the right" },
  { id: 2, hint: "Settings and access side by side, access levels as buttons" },
  { id: 3, hint: "Libraries as tabs, access as a person × permission table" },
  { id: 4, hint: "People grouped into lanes by access level" },
  { id: 5, hint: "Settings edited in the list, the detail is access only" },
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
  if (props.layout === 2) return <SideBySide {...ctx} />;
  if (props.layout === 3) return <TabsTable {...ctx} />;
  if (props.layout === 4) return <Lanes {...ctx} />;
  if (props.layout === 5) return <SettingsInList {...ctx} />;
  return <MasterDetail {...ctx} />;
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

/* Option 1: list of libraries beside the selected library. */
function MasterDetail(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  const library = ctx.libraries[path];
  return <div className="lib-opt-split">
    <LibraryIndex ctx={ctx} path={path} onSelect={select} />
    <article className="admin-surface lib-opt-detail">
      <DetailHeader ctx={ctx} path={path} />
      <LibrarySettings ctx={ctx} path={path} />
      <h3>Access <small>{library.members.length} enabled</small></h3>
      <AccessList ctx={ctx} path={path} chips />
    </article>
  </div>;
}

/* Option 2: settings and access side by side in the detail; access levels as buttons, permissions behind Customize. */
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

/* Option 3: libraries as tabs across the top; access as a person × permission table. */
function TabsTable(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  return <div className="lib-opt-tabbed">
    <nav className="lib-opt-tabs" role="tablist" aria-label="Libraries">{ctx.paths.map((candidate) => <button key={candidate} type="button" role="tab" aria-selected={candidate === path} className={candidate === path ? "active" : undefined} onClick={() => select(candidate)}>{candidate}<small>{ctx.libraries[candidate].members.length}</small></button>)}</nav>
    <article className="admin-surface lib-opt-detail">
      <DetailHeader ctx={ctx} path={path} />
      <LibrarySettings ctx={ctx} path={path} />
      <div className="lib-opt-scroll"><table className="lib-opt-table">
        <thead><tr><th>Person</th><th>Access</th>{ctx.permissions.map((permission) => <th key={permission.key} title={permission.description}>{permission.label}</th>)}</tr></thead>
        <tbody>{ctx.names.map((name) => {
          const member = ctx.memberOf(path, name);
          const admin = ctx.isAdmin(name);
          return <tr key={name}>
            <th scope="row"><span className="lib-opt-person-cell"><Avatar name={name} />{name}</span></th>
            <td><PresetSelect ctx={ctx} path={path} name={name} /></td>
            {ctx.permissions.map((permission) => <td key={permission.key}><input type="checkbox" aria-label={`${name} ${permission.label} for ${path}`} checked={admin || Boolean(member?.[permission.key])} disabled={admin || !member} onChange={(event) => ctx.setPermission(path, name, permission.key, event.target.checked)} /></td>)}
          </tr>;
        })}</tbody>
      </table></div>
    </article>
  </div>;
}

/* Option 4: people grouped into lanes by access level. */
function Lanes(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  const admins = ctx.names.filter(ctx.isAdmin);
  const others = ctx.names.filter((name) => !ctx.isAdmin(name));
  return <div className="lib-opt-split">
    <LibraryIndex ctx={ctx} path={path} onSelect={select} />
    <article className="admin-surface lib-opt-detail">
      <DetailHeader ctx={ctx} path={path} />
      <LibrarySettings ctx={ctx} path={path} />
      <div className="lib-opt-lanes">{PRESETS.map((preset) => {
        const people = others.filter((name) => ctx.presetOf(ctx.memberOf(path, name)) === preset);
        return <section key={preset} className={`is-${preset}`}>
          <h3>{ctx.presetLabel(preset)} <small>{people.length}</small></h3>
          {people.map((name) => <div key={name} className="lib-opt-lane-card">
            <span className="lib-opt-person-cell"><Avatar name={name} /><b>{name}</b></span>
            <PresetSelect ctx={ctx} path={path} name={name} />
          </div>)}
        </section>;
      })}</div>
      {admins.length > 0 && <p className="lib-opt-admins">Full access as administrators: {admins.join(", ")}</p>}
    </article>
  </div>;
}

/* Option 5: settings edited in the library list; the detail is access only, with a people filter. */
function SettingsInList(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  const [filter, setFilter] = useState("");
  const shown = ctx.names.filter((name) => name.toLowerCase().includes(filter.trim().toLowerCase()));
  return <div className="lib-opt-split is-wide-index">
    <div className="admin-surface lib-opt-index lib-opt-index-cards">{ctx.paths.map((candidate) => <section key={candidate} className={candidate === path ? "active" : undefined}>
      <button type="button" className="lib-opt-index-head" aria-current={candidate === path ? "true" : undefined} onClick={() => select(candidate)}><b>{candidate}</b><small>{ctx.status(candidate) || `${ctx.libraries[candidate].members.length} people`}</small></button>
      <LibrarySettings ctx={ctx} path={candidate} />
    </section>)}</div>
    <article className="admin-surface lib-opt-detail">
      <header><h2>{path} access</h2><input className="lib-opt-filter" type="search" placeholder="Filter people" aria-label="Filter people" value={filter} onChange={(event) => setFilter(event.target.value)} /></header>
      <ul className="lib-opt-access is-buttons">{shown.map((name) => <li key={name}>
        <Avatar name={name} />
        <b>{name}</b>
        <PresetButtons ctx={ctx} path={path} name={name} />
        <span />
        <PermissionChips ctx={ctx} path={path} name={name} />
      </li>)}</ul>
      {!shown.length && <p className="lib-opt-admins">No one matches “{filter}”.</p>}
    </article>
  </div>;
}
