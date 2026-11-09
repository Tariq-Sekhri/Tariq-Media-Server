"use client";

import { useState } from "react";

type ContentType = "mixed" | "movies_tv" | "music" | "files";
type Member = { name: string; can_view: boolean; can_delete: boolean; can_move: boolean; can_create_folders: boolean; can_upload: boolean; can_download: boolean; can_rename: boolean };
type Library = { content_type: ContentType; members: Member[]; title_folders: string[]; trickplay_enabled: boolean; folder_structure_static: boolean };
type PermissionKey = keyof Omit<Member, "name">;
type Preset = "none" | "viewer" | "user" | "editor" | "manager";
type User = { name: string; is_admin: boolean };

export type LibrariesOptionProps = {
  libraries: Record<string, Library>;
  users: User[];
  types: { value: ContentType; label: string }[];
  permissions: { key: PermissionKey; label: string; description: string }[];
  presetOf: (member: Member | undefined) => Preset;
  presetLabel: (preset: Preset) => string;
  update: (path: string, update: (library: Library) => Library) => void;
  setPreset: (path: string, name: string, preset: Preset) => void;
  setPermission: (path: string, name: string, permission: PermissionKey, enabled: boolean) => void;
  savingLibrary: string;
  savedLibrary: string;
};

const PRESETS: Preset[] = ["none", "viewer", "user", "editor", "manager"];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export default function LibrariesOptions(props: LibrariesOptionProps) {
  const paths = Object.keys(props.libraries);
  const isAdmin = (name: string) => Boolean(props.users.find((user) => same(user.name, name))?.is_admin);
  const names = [...new Set([...props.users.map((user) => user.name), ...paths.flatMap((path) => props.libraries[path].members.map((member) => member.name))])].filter((name) => !isAdmin(name)).sort((a, b) => a.localeCompare(b));
  const accessCount = (path: string) => props.libraries[path].members.filter((member) => member.can_view && !isAdmin(member.name)).length;
  // Stable sorting preserves the existing server order when access counts match.
  paths.sort((a, b) => accessCount(b) - accessCount(a));
  const memberOf = (path: string, name: string) => props.libraries[path].members.find((member) => same(member.name, name));
  const typeLabel = (type: ContentType) => props.types.find((option) => option.value === type)?.label ?? type;
  const status = (path: string) => props.savingLibrary === path ? "Saving…" : props.savedLibrary === path ? "Saved" : "";
  const ctx = { ...props, paths, names, isAdmin, accessCount, memberOf, typeLabel, status };
  return <SideBySide {...ctx} />;
}

type Ctx = LibrariesOptionProps & {
  paths: string[];
  names: string[];
  isAdmin: (name: string) => boolean;
  accessCount: (path: string) => number;
  memberOf: (path: string, name: string) => Member | undefined;
  typeLabel: (type: ContentType) => string;
  status: (path: string) => string;
};

function TypeSelect({ ctx, path }: { ctx: Ctx; path: string }) {
  return <select aria-label={`Library type for ${path}`} value={ctx.libraries[path].content_type} onChange={(event) => ctx.update(path, (library) => ({ ...library, content_type: event.target.value as ContentType }))}>
    {ctx.types.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
  </select>;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="lib-opt-switch"><input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function PermissionChips({ ctx, path, name }: { ctx: Ctx; path: string; name: string }) {
  const member = ctx.memberOf(path, name);
  if (ctx.isAdmin(name) || !member?.can_view) return null;
  return <div className="lib-opt-chips">{ctx.permissions.map((permission) => <button key={permission.key} type="button" title={permission.description} aria-pressed={Boolean(member[permission.key])} className={member[permission.key] ? "on" : undefined} onClick={() => ctx.setPermission(path, name, permission.key, !member[permission.key])}>{permission.label}</button>)}</div>;
}

const SELECTED_KEY = "tms.admin.selectedLibrary";

/** The library open in the detail pane, remembered in this browser. */
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
      <b>{candidate}</b><small>{ctx.typeLabel(item.content_type)} · {ctx.accessCount(candidate)} {ctx.accessCount(candidate) === 1 ? "person" : "people"}</small>
      {rich && (item.folder_structure_static || item.trickplay_enabled) && <span className="lib-opt-flags">{item.folder_structure_static && <em>Static</em>}{item.trickplay_enabled && <em>Previews</em>}</span>}
    </button>;
  })}</nav>;
}

function PresetButtons({ ctx, path, name }: { ctx: Ctx; path: string; name: string }) {
  if (ctx.isAdmin(name)) return <span className="lib-opt-admin">Full access</span>;
  const preset = ctx.presetOf(ctx.memberOf(path, name));
  return <div className="lib-opt-seg" role="radiogroup" aria-label={`${name} access to ${path}`}>{PRESETS.map((value) => <button key={value} type="button" role="radio" aria-checked={preset === value} className={preset === value ? `on is-${value}` : undefined} onClick={() => ctx.setPreset(path, name, value)}>{ctx.presetLabel(value)}</button>)}</div>;
}

const Avatar = ({ name }: { name: string }) => <span className="lib-opt-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>;

/* Settings and access side by side; permissions behind Custom. */
function SideBySide(ctx: Ctx) {
  const [path, select] = useSelectedLibrary(ctx);
  const [custom, setCustom] = useState<string | null>(null);
  const library = ctx.libraries[path];
  return <div className="lib-opt-split">
    <LibraryIndex ctx={ctx} path={path} onSelect={select} rich />
    <article className="admin-surface lib-opt-detail">
      <div className="lib-opt-columns">
        <section className="lib-opt-stack">
          <h3>Settings {ctx.status(path) && <span className="lib-opt-save-status" role="status">{ctx.status(path)}</span>}</h3>
          <label className="lib-opt-field is-stacked"><span>Type</span><TypeSelect ctx={ctx} path={path} /></label>
          <Switch label="Static folders" checked={library.folder_structure_static} onChange={(checked) => ctx.update(path, (current) => ({ ...current, folder_structure_static: checked }))} />
          <Switch label="Timeline previews" checked={library.trickplay_enabled} onChange={(checked) => ctx.update(path, (current) => ({ ...current, trickplay_enabled: checked }))} />
        </section>
        <section>
          <h3>Access <small>{ctx.accessCount(path)} enabled</small></h3>
          <ul className="lib-opt-access is-buttons">{ctx.names.map((name) => {
            const enabled = !ctx.isAdmin(name) && Boolean(ctx.memberOf(path, name)?.can_view);
            const key = `${path}\n${name}`;
            return <li key={name}>
              <div className="lib-opt-access-controls">
                <Avatar name={name} />
                <b>{name}</b>
                <PresetButtons ctx={ctx} path={path} name={name} />
                {enabled ? <button type="button" className="lib-opt-link" aria-expanded={custom === key} onClick={() => setCustom(custom === key ? null : key)}>Custom</button> : <span />}
              </div>
              {custom === key && enabled && <PermissionChips ctx={ctx} path={path} name={name} />}
            </li>;
          })}</ul>
        </section>
      </div>
    </article>
  </div>;
}
