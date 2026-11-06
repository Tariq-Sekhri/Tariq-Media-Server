"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, jsonRequest } from "./api";
import type { Bootstrap, Title } from "./Discover";

export type Permission = { user_id: number; library: string; can_request: boolean; auto_approve_requests: boolean; weekly_limit: number };
type RequestRow = { kind: string; tmdb_id: number; id: string; title: string; season: number | null; library: string; status: string; error: string | null; progress: number; subscribers: number[]; created_at: number; monitor_future: boolean; service_id: number | null; hash: string | null; submitted: boolean; search_started?: boolean; torrent_hash?: string | null; requested_by_name?: string; download_user_id?: number | null; download_user_name?: string; quota_override_by?: number | null; subscription_id?: string | null; auto_pick_note?: string | null; auto_download?: boolean };
export type Subscription = { id: string; tmdb_id: number; title: string; library: string; owner_id: number; owner_name: string; subscribers: number[]; following: boolean; created_at: number; last_checked: number; error: string | null };
type ReleaseOption = { option: number; recommended: boolean; guid: string; indexer_id: number; title: string; quality: string; size_label: string; seeders: number; leechers: number; indexer: string; published: string; series_pack?: boolean; season_pack?: boolean; covered_seasons?: number[]; english_audio?: boolean };
const seasonLabel = (season: number) => season === 0 ? "Specials / extras" : `Season ${season}`;
const statuses: Record<string,string> = { pending:"Pending approval", queued:"Queued", pick:"Available torrents", submitting:"Submitting", searching:"Searching / waiting for release", downloading:"Downloading", importing:"Importing", ready:"Ready", partial:"Partially available", failed:"Needs attention", cancelling:"Cancelling", monitoring:"Watching for new episodes" };
const pickable = (status: string) => ["pending", "queued", "pick", "failed", "searching"].includes(status);
// Requests an administrator can hand to auto pick instead of choosing a torrent.
// Rows auto pick is working on leave the inbox (the server stops listing
// them); they return with a note or error only if it needs an admin.
const autoPickable = (r: RequestRow) => !r.hash && !r.subscription_id && pickable(r.status);

// Keep automatic loading from flooding Sonarr/indexers with every season at once.
let releaseSearches = 0;
const waitingSearches: (() => void)[] = [];
async function fetchReleases(requestId: string, refresh = false) {
  if (releaseSearches >= 2) await new Promise<void>(resolve => waitingSearches.push(resolve));
  else releaseSearches++;
  try {
    return await api<{ releases: ReleaseOption[]; budget_gb: number; searching?: boolean; error?: string }>(`/requests/${requestId}/releases${refresh ? "?refresh=1" : ""}`, { signal: AbortSignal.timeout(15000) });
  } finally {
    const next = waitingSearches.shift();
    if (next) next();
    else releaseSearches--;
  }
}

export function RequestForm({ title, kind, bootstrap, onSubmitted, onConfigure }: { title: Title; kind: string; bootstrap: Bootstrap; onSubmitted: () => void; onConfigure?: () => void }) {
  const allowed=bootstrap.request_access?.filter(p=>p.can_request&&bootstrap.libraries.includes(p.library))||[];
  const missingSeasons=(destination:string)=>{
    const available=bootstrap.availability.filter(a=>a.kind===kind&&a.tmdb_id===title.id&&a.path.split('/')[0]===destination);
    return title.seasons?.filter(s=>s.episode_count<=0||new Set(available.flatMap(a=>a.episodes[String(s.season_number)]||[])).size<s.episode_count).map(s=>s.season_number)||[];
  };
  const [library,setLibrary]=useState(allowed[0]?.library||"");
  const [seasons,setSeasons]=useState<number[]>(()=>missingSeasons(allowed[0]?.library||""));
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [subscriptions,setSubscriptions]=useState<Subscription[]>([]);
  useEffect(()=>{if(kind!=="tv")return;let active=true;api<{subscriptions:Subscription[]}>("/subscriptions").then(d=>{if(active)setSubscriptions(d.subscriptions);}).catch(e=>{if(active)setMessage((e as Error).message);});return()=>{active=false;};},[kind]);
  if (!allowed.length) return <div className="discover-request-unavailable"><p className="discover-muted">{bootstrap.can_manage ? "No library accepts requests yet." : "Ask your administrator for request access to add titles to a library."}</p>{bootstrap.can_manage && onConfigure && <button type="button" onClick={onConfigure}>Configure request access</button>}</div>;
  const existing=bootstrap.availability.filter(a=>a.kind===kind&&a.tmdb_id===title.id&&a.path.split('/')[0]===library);
  const complete=(season:number,count:number)=>count>0&&new Set(existing.flatMap(a=>a.episodes[String(season)]||[])).size>=count;
  const permitted=allowed.find(p=>p.library===library);
  const followed=subscriptions.find(s=>s.tmdb_id===title.id&&s.library===library&&s.following);
  const subscribe=async()=>{setBusy(true);setMessage("");try{const data=await api<{subscription:Subscription}>("/subscriptions",jsonRequest("POST",{tmdb_id:title.id,library}));setSubscriptions(old=>[...old.filter(s=>s.id!==data.subscription.id),data.subscription]);setMessage("Subscribed. New episodes will download automatically as they air.");}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
  const unsubscribe=async(id:string)=>{setBusy(true);setMessage("");try{await api(`/subscriptions/${id}`,{method:"DELETE"});setSubscriptions(old=>old.filter(s=>s.id!==id));setMessage("Unsubscribed. New episodes will no longer download automatically.");}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
  return <form className="discover-request-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setMessage("");try{const data=await api<{created:number;automatic:number}>("/requests",jsonRequest("POST",{kind,tmdb_id:title.id,library,seasons,monitor_future:false}));setMessage(data.created?(data.automatic===data.created?(kind==="tv"?"Approved. Auto pick is looking for complete seasons first, then individual episodes.":"Approved. Auto pick is looking for a release within your budget."):data.automatic>0?"Completed seasons approved and auto picking. Other seasons await administrator review.":"Request saved. An administrator will review it."):"You’re following the existing request.");onSubmitted();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}}>
    {kind==="tv"?<h3>Seasons</h3>:!permitted?.auto_approve_requests&&<h3>Request this title</h3>}{allowed.length>1&&<label>Destination <select value={library} onChange={e=>{setLibrary(e.target.value);setSeasons(missingSeasons(e.target.value));}}>{allowed.map(p=><option key={p.library}>{p.library}</option>)}</select></label>}
    {kind==="tv"&&<div className="discover-season-options">{title.seasons?.map(s=><label key={s.season_number}><input type="checkbox" checked={seasons.includes(s.season_number)} disabled={complete(s.season_number,s.episode_count)} onChange={e=>setSeasons(old=>e.target.checked?[...old,s.season_number]:old.filter(n=>n!==s.season_number))}/>{s.season_number === 0 ? "Specials / extras (optional)" : s.name}<small>{complete(s.season_number,s.episode_count)?"Available":`${s.episode_count} episodes`}</small></label>)}</div>}
    {kind==="movie"&&existing.length>0?<p>Already available in this library.</p>:<div className="discover-request-actions"><button className="discover-request-primary" disabled={busy||!library||(kind==="tv"&&!seasons.length)}>{busy?"Saving…":"Request title"}</button>{kind==="tv"&&(followed?<button type="button" disabled={busy} onClick={()=>void unsubscribe(followed.id)}>Subscribed · Unsubscribe</button>:<button type="button" disabled={busy||!library} onClick={()=>void subscribe()}>Subscribe to new episodes</button>)}</div>}{message&&<p role="status">{message}</p>}
    <p className="discover-request-outcome">{permitted?.auto_approve_requests ? "Eligible releases are added automatically; other requests need administrator approval." : "Requires administrator approval."}</p><details className="discover-request-policy"><summary>How requests work</summary><p className="discover-muted">Digitally released movies and completed seasons are approved automatically when you have room for the 50 GiB budget. Other requests are reviewed by an administrator. Approved requests pick a torrent automatically: a complete season first, otherwise each aired episode, and shows that are still airing are followed for new episodes.</p></details>
  </form>;
}

function ReleasePicker({ requestId, onPicked, onReleases, refreshKey, blocked }: { requestId: string; onPicked: () => void; onReleases: (id: string, releases: ReleaseOption[]) => void; refreshKey: number; blocked: boolean }) {
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  const [budget, setBudget] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [searchTick, setSearchTick] = useState(0);
  const previousRefreshKey = useRef(refreshKey);
  const load = async (refresh = false) => {
    setLoading(true); setError("");
    try {
      const data = await fetchReleases(requestId, refresh);
      setReleases(data.releases); onReleases(requestId, data.releases); setBudget(data.budget_gb);
      setLoading(Boolean(data.searching)); setError(data.error || "");
    } catch (e) { setError((e as Error).message); setReleases([]); setLoading(false); }
    finally { setSearchTick(tick => tick + 1); }
  };
  useEffect(() => { void load(); }, [requestId]);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void load(true);
  }, [refreshKey]);
  useEffect(() => {
    if (busy || !loading) return;
    const timer = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(timer);
  }, [loading, busy, releases.length, requestId, searchTick]);
  const grab = async (release: ReleaseOption) => {
    setBusy(release.guid); setError("");
    try {
      await api(`/requests/${requestId}`, jsonRequest("POST", { action: "grab", guid: release.guid, indexer_id: release.indexer_id }));
      onPicked();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };

  return <div className="discover-release-picker">
    <div className="discover-release-toolbar">
      <b>Available torrents</b>
      <span>Within {budget || "…"} GiB budget</span>
      <button type="button" disabled={loading || Boolean(busy) || blocked} onClick={() => void load(true)}>{loading ? "Searching…" : "Refresh info"}</button>
    </div>
    {error && <p className="discover-error" role="alert">{error}</p>}
    {loading && !releases.length ? <p role="status">Searching indexers…</p> : null}
    {!loading && !releases.length && !error ? <p className="discover-empty">No torrents fit the budget right now.</p> : null}
    <ReleaseList releases={releases.filter(release => !release.series_pack)} busy={Boolean(busy) || blocked} grab={grab} />
    {!loading && releases.length > 0 && releases.every(release => release.series_pack) && <p className="discover-muted">Multi-season options are listed above.</p>}
  </div>;
}

function ReleaseList({ releases, busy, grab }: { releases: ReleaseOption[]; busy: boolean; grab: (release: ReleaseOption) => void }) {
    return <div className="discover-release-list" role="list">
      {releases.map(release => <button type="button" role="listitem" key={`${release.indexer_id}:${release.guid}`} className={`discover-release-row${release.recommended ? " recommended" : ""}`} disabled={Boolean(busy)} onClick={() => void grab(release)}>
        <span className="discover-release-option">Option {release.option}{release.series_pack ? " · multi-season" : ""}{release.season_pack ? " · complete season" : ""}{release.english_audio ? " · English audio" : ""}{release.recommended ? " · auto pick" : ""}</span>
        <span className="discover-release-title">{release.title}</span>
        {release.series_pack && !!release.covered_seasons?.length && <span className="discover-muted">Seasons {release.covered_seasons.filter(n => n > 0).join(", ")} · one download</span>}
        <span className="discover-release-meta">
          <span>{release.published || "—"}</span>
          <span>{release.quality}</span>
          <span>{release.size_label}</span>
          <span title="Seeders">{release.seeders}</span>
          <span title="Leechers">{release.leechers}</span>
          <span>{release.indexer.replace(/\s*\(Prowlarr\)\s*$/i, "")}</span>
        </span>
      </button>)}
    </div>;
}

export function RequestsPanel({canManage,refreshKey,title,onCountChange}:{canManage:boolean;refreshKey:number;title?:string;onCountChange?:(count:number)=>void}) {
  const [rows,setRows]=useState<RequestRow[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState("");
  const [expandedSeasons, setExpandedSeasons] = useState<Record<string, boolean>>({});
  const [releaseRows, setReleaseRows] = useState<Record<string, ReleaseOption[]>>({});
  const [releaseRefresh, setReleaseRefresh] = useState<Record<string, number>>({});
  const collectReleases = useCallback((id: string, releases: ReleaseOption[]) => setReleaseRows(old => ({...old, [id]: releases})), []);
  const [magnets,setMagnets]=useState<Record<string,string>>({});
  const [subscriptions,setSubscriptions]=useState<Subscription[]>([]);
  const refreshRows=useCallback(async()=>{const [result,subscribed]=await Promise.all([api<{requests:RequestRow[]}>("/requests"),api<{subscriptions:Subscription[]}>("/subscriptions")]);setRows(result.requests);setSubscriptions(subscribed.subscriptions);onCountChange?.(result.requests.length);},[onCountChange]);
  useEffect(()=>{let stopped=false;let timer:number;const poll=async()=>{try{await refreshRows();if(!stopped)setError("");}catch(e){if(!stopped)setError((e as Error).message);}finally{if(!stopped)timer=window.setTimeout(poll,5000);}};void poll();return()=>{stopped=true;window.clearTimeout(timer);};},[refreshKey,refreshRows]);
  const action=async(id:string,name:string)=>{setBusy(id);setError("");try{await api(`/requests/${id}`,jsonRequest("POST",{action:name,magnet:magnets[id]}));await refreshRows();}catch(e){setError((e as Error).message);}finally{setBusy("");}};
  const autoPickGroup=async(group:RequestRow[])=>{const ids=group.filter(autoPickable).map(r=>r.id);if(!ids.length)return;setBusy(`auto:${group[0].id}`);setError("");try{for(const id of ids)await api(`/requests/${id}`,jsonRequest("POST",{action:"auto"}));await refreshRows();}catch(e){setError((e as Error).message);}finally{setBusy("");}};
  const cancelGroup=async(group:RequestRow[])=>{const ids=group.filter(r=>!["ready","cancelling"].includes(r.status)).map(r=>r.id);if(!ids.length)return;setBusy(`group:${ids[0]}`);setError("");try{await Promise.all(ids.map(id=>api(`/requests/${id}`,jsonRequest("POST",{action:"cancel"}))));await refreshRows();}catch(e){setError((e as Error).message);}finally{setBusy("");}};
  const removeSubscription=async(id:string)=>{setBusy(`subscription:${id}`);setError("");try{await api(`/subscriptions/${id}`,{method:"DELETE"});await refreshRows();}catch(e){setError((e as Error).message);}finally{setBusy("");}};
  const changeQuota=async(r:RequestRow,quota:"requester"|"override"|"admin")=>{setBusy(r.id);setError("");try{await api(`/requests/${r.id}`,jsonRequest("POST",{action:"quota",quota}));await refreshRows();}catch(e){setError((e as Error).message);}finally{setBusy("");}};
  const quotaControls=(r:RequestRow)=>canManage&&<div className="discover-request-quota">
    <span>{r.quota_override_by ? "Requester quota overridden; usage stays on the requester." : r.download_user_id ? `Charged to ${r.download_user_name || "administrator"}.` : "Charged to the requester."}</span>
    {!r.hash&&!r.torrent_hash&&(!r.submitted||Boolean(r.service_id))&&!r.search_started&&<div className="discover-request-actions">
      {!r.quota_override_by&&<button type="button" disabled={Boolean(busy)} onClick={()=>void changeQuota(r,"override")}>Ignore requester quota{r.status==="failed"?" & retry":""}</button>}
      {!r.download_user_id&&<button type="button" disabled={Boolean(busy)} onClick={()=>void changeQuota(r,"admin")}>Use my quota{r.status==="failed"?" & retry":""}</button>}
      {(r.quota_override_by||r.download_user_id)&&<button type="button" disabled={Boolean(busy)} onClick={()=>void changeQuota(r,"requester")}>Use requester quota</button>}
    </div>}
  </div>;
  const visible=[...rows].sort((a,b)=>b.created_at-a.created_at);
  const groups=visible.reduce<Record<string,RequestRow[]>>((all,row)=>{const key=`${row.kind}:${row.tmdb_id}:${row.library}`;(all[key]||=[]).push(row);return all;},{});
  const controls=(r:RequestRow)=><><div className="discover-request-actions">{canManage&&r.status==="pending"&&<><button disabled={busy===r.id} onClick={()=>void action(r.id,"approve")}>Approve</button><button disabled={busy===r.id} onClick={()=>void action(r.id,"decline")}>Decline</button></>}{canManage&&r.status==="failed"&&<button disabled={busy===r.id} onClick={()=>void action(r.id,"retry")}>Retry</button>}{canManage&&autoPickable(r)&&<button disabled={busy===r.id} title="Auto pick a complete season, or each aired episode, without choosing a torrent" onClick={()=>void action(r.id,"auto")}>Download automatically</button>}{!["ready","cancelling"].includes(r.status)&&<button disabled={busy===r.id} onClick={()=>void action(r.id,"cancel")}>{canManage?"Cancel request":"Stop following"}</button>}</div>{canManage&&!r.hash&&pickable(r.status)&&<ReleasePicker blocked={Boolean(busy)} requestId={r.id} onReleases={collectReleases} refreshKey={releaseRefresh[r.id] || 0} onPicked={()=>{void refreshRows().catch(e=>setError(e.message));}} />}{canManage&&["queued","pick","failed"].includes(r.status)&&!r.service_id&&!r.submitted&&<form className="discover-inline" onSubmit={e=>{e.preventDefault();void action(r.id,"magnet");}}><input aria-label={`Magnet for ${r.title}`} placeholder="Optional: attach a magnet link" value={magnets[r.id]||""} onChange={e=>setMagnets(old=>({...old,[r.id]:e.target.value}))} required/><button disabled={busy===r.id}>Start magnet download</button></form>}</>;
  return <section className="discover-requests"><div className="discover-header"><h2>{title || (canManage?"Requests":"Your requests")}</h2></div>{error&&<p className="discover-error" role="alert">{error}</p>}{subscriptions.length>0&&<div className="discover-subscriptions"><h3>Subscriptions</h3>{subscriptions.map(s=><div className="discover-subscription-row" key={s.id}><div><b>{s.title}</b><span>{s.library} · {s.subscribers.length} following{canManage?` · Added by ${s.owner_name}`:""}</span>{s.error&&<p className="discover-error">{s.error}</p>}</div><button type="button" disabled={Boolean(busy)} onClick={()=>void removeSubscription(s.id)}>{busy===`subscription:${s.id}`?"Removing…":canManage?"Remove subscription":"Unsubscribe"}</button></div>)}</div>}{!rows.length&&<p className="discover-empty">Requests that need action will appear here.</p>}
    {Object.values(groups).map(group=>{const first=group[0];const seasons=group.filter(r=>r.season!==null).map(r=>seasonLabel(r.season!)).join(", ");const canCancelGroup=group.some(r=>!["ready","cancelling"].includes(r.status));const groupBusy=busy===`group:${first.id}`;const packs = new Map<string, {release: ReleaseOption; requestId: string}>();
      for (const row of group.filter(r => !r.hash && pickable(r.status) && r.service_id)) {
        for (const release of releaseRows[row.id] || []) {
          if (!release.series_pack) continue;
          const key = release.guid.match(/urn:btih:([a-z0-9]+)/i)?.[1].toLowerCase() || `${release.indexer_id}:${release.guid}`;
          const previous = packs.get(key);
          if (!previous || release.seeders > previous.release.seeders) packs.set(key, {release, requestId: row.id});
        }
      }
      const groupKey = `${first.kind}:${first.tmdb_id}:${first.library}`;
      const collapseSeasons = canManage && packs.size > 0 && !expandedSeasons[groupKey];
      const coverage = (release: ReleaseOption) => group.filter(r => r.season !== null && release.covered_seasons?.includes(r.season)).length;
      const packOptions = [...packs.values()].sort((a,b) => coverage(b.release)-coverage(a.release) || b.release.seeders-a.release.seeders);
      const autoPickSizes = [...new Set(group.flatMap(r => (releaseRows[r.id] || []).filter(release => release.recommended).map(release => release.size_label)).filter(Boolean))];
      return <details className="discover-request-row" key={`${first.kind}:${first.tmdb_id}:${first.library}`}><summary className="discover-request-summary"><b>{first.title}</b><span className="request-lifecycle" data-status={first.status}>{[...new Set(group.map(r => statuses[r.status] || r.status))].join(" · ")}</span><span>Requested by {first.requested_by_name || "Unknown user"}</span>{group.some(r => r.status === "downloading") && <span className="request-transfer-status">{group.length === 1 && first.progress > 0 ? <><progress aria-label={`Server download for ${first.title}`} value={first.progress} max={1} /> {Math.round(first.progress * 100)}%</> : <><progress aria-label={`Server download for ${first.title}`} /> Waiting for progress</>}</span>}{autoPickSizes.length > 0 && <span>Auto pick {autoPickSizes.join(", ")}</span>}{canManage&&group.length===1&&first.status==="pending"&&<span className="discover-request-quick"><button type="button" className="discover-request-primary" disabled={busy===first.id} onClick={(event)=>{event.preventDefault();event.stopPropagation();void action(first.id,"approve");}}>Approve</button><button type="button" disabled={busy===first.id} onClick={(event)=>{event.preventDefault();event.stopPropagation();void action(first.id,"decline");}}>Decline</button></span>}<button type="button" className="discover-request-toggle" aria-label={`Details for ${first.title}`} onClick={event => { event.preventDefault(); const details = event.currentTarget.closest("details"); if (details) details.open = !details.open; }}>Show details</button></summary><div className="discover-request-details"><div><b>{first.title}</b><p>{first.library} · {new Date(first.created_at*1000).toLocaleDateString()} · {first.subscribers.length} following</p>{seasons&&<p className="discover-request-seasons">{seasons}</p>}{(canCancelGroup||(canManage&&group.filter(autoPickable).length>1))&&<div className="discover-request-group-actions">{canManage&&group.filter(autoPickable).length>1&&<button disabled={Boolean(busy)} onClick={()=>void autoPickGroup(group)}>{busy===`auto:${first.id}`?"Starting auto pick…":"Download all automatically"}</button>}{canCancelGroup&&<button disabled={Boolean(busy)} onClick={()=>void cancelGroup(group)}>{groupBusy?"Cancelling request…":"Cancel whole request"}</button>}</div>}</div>{canManage && packOptions.length > 0 && <div className="discover-release-picker discover-request-packs">
        <div className="discover-release-toolbar"><b>Multi-season torrents</b><button disabled={Boolean(busy)} onClick={() => setReleaseRefresh(old => ({...old, ...Object.fromEntries(group.map(r => [r.id, (old[r.id] || 0) + 1]))}))}>Refresh info</button></div>
        <p className="discover-muted">Pick once to download the pack and handle its covered season requests.</p>
        <ReleaseList releases={packOptions.map(({release}, index) => ({...release, option: index + 1, recommended: index === 0}))} busy={Boolean(busy)} grab={async release => {
          const source = packOptions.find(p => p.release.guid === release.guid && p.release.indexer_id === release.indexer_id)!;
          setBusy(source.requestId); setError("");
          try { await api(`/requests/${source.requestId}`, jsonRequest("POST", {action: "grab", guid: release.guid, indexer_id: release.indexer_id})); await refreshRows(); }
          catch (e) { setError((e as Error).message); } finally { setBusy(""); }
        }} />
      </div>}{canManage && packOptions.length > 0 && <div className="discover-request-group-actions"><button type="button" aria-expanded={!collapseSeasons} aria-controls={`request-seasons-${first.id}`} onClick={() => setExpandedSeasons(old => ({...old, [groupKey]: !old[groupKey]}))}>{collapseSeasons ? "Show individual seasons" : "Hide individual seasons"}</button></div>}<div id={`request-seasons-${first.id}`} hidden={collapseSeasons} style={{display: collapseSeasons ? "none" : "contents"}}>{group.map(r=><div className="discover-request-season" key={r.id}><div><b>{r.season!==null?seasonLabel(r.season):"Movie"}</b><span>{statuses[r.status]||r.status}{r.monitor_future&&r.status!=="monitoring"?" · Monitoring":""}</span>{r.season===0&&!r.hash&&<p className="discover-muted">Optional specials and extras. Season packs may not include these.</p>}{r.progress>0&&<progress value={r.progress} max={1} />}{r.error&&<p className="discover-error">{r.error}</p>}{r.auto_pick_note&&<p className="discover-muted">Auto pick: {r.auto_pick_note}</p>}{!canManage&&pickable(r.status)&&!r.hash&&<p className="discover-muted">Waiting for an administrator to choose a torrent.</p>}{quotaControls(r)}</div>{controls(r)}</div>)}</div></div></details>;})}
  </section>;
}
export function RequestPermissions({libraries, standalone = false}:{libraries:string[]; standalone?: boolean}) {
  const Container = standalone ? "section" : "details";
  const [members,setMembers]=useState<Permission[]>([]);const [users,setUsers]=useState<{id:number;name:string}[]>([]);const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);
  useEffect(()=>{api<{members:Permission[];users:{id:number;name:string}[]}>("/policy").then(d=>{setMembers(d.members);setUsers(d.users);}).catch(e=>setMessage(e.message));},[]);
  const change=(id:number,library:string,patch:Partial<Permission>)=>setMembers(old=>{const item=old.find(p=>p.user_id===id&&p.library===library)||{user_id:id,library,can_request:false,auto_approve_requests:false,weekly_limit:10};return [...old.filter(p=>p!==item),{...item,...patch}];});
  return <Container id="discover-request-permissions" tabIndex={-1}>{!standalone && <summary>Request permissions</summary>}<p>Limits count movies and seasons over the last seven days. Zero means unlimited. Library viewing access is still required.</p>{users.map(u=><div key={u.id}><h4>{u.name}</h4>{libraries.map(l=>{const p=members.find(m=>m.user_id===u.id&&m.library===l);return <div key={l} className="discover-policy-row"><b>{l}</b><label><input type="checkbox" checked={p?.can_request||false} onChange={e=>change(u.id,l,{can_request:e.target.checked})}/>Can request</label><label><input type="checkbox" checked={p?.auto_approve_requests||false} onChange={e=>change(u.id,l,{auto_approve_requests:e.target.checked})}/>Auto approve</label><label>Weekly limit<input type="number" min="0" max="1000" value={p?.weekly_limit??10} onChange={e=>change(u.id,l,{weekly_limit:Number(e.target.value)})}/></label></div>;})}</div>)}<button disabled={busy} onClick={async()=>{setBusy(true);try{await api("/policy",jsonRequest("PUT",{members}));setMessage("Permissions saved.");}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}}>Save permissions</button>{message&&<p role="status">{message}</p>}</Container>;
}
