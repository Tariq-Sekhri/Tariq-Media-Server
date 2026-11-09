"use client";

import { useCallback, useEffect, useState } from "react";
import { api, jsonRequest } from "./api";
import { RequestForm, type Permission } from "./Requests";
import "./style.css";
import CachedArtworkImage from "../CachedArtworkImage";
import { useBackLayer } from "../lib/back-layers";

export type Title = { id: number; media_type?: string; title?: string; name?: string; poster_path?: string; backdrop_path?: string; overview?: string; release_date?: string; first_air_date?: string; vote_average?: number; seasons?: { season_number: number; episode_count: number; name: string; air_date?: string }[]; genres?: { id: number; name: string }[]; credits?: { cast: { id: number; name: string }[] }; videos?: { results: { site: string; key: string; type: string }[] }; recommendations?: { results: Title[] } };
export type Available = { kind: string; tmdb_id: number; path: string; episodes: Record<string, number[]>; file_count: number };
export type Bootstrap = { configured: boolean; is_admin: boolean; can_manage: boolean; libraries: string[]; availability: Available[]; request_access: Permission[]; searches?: string[] };
const KINDS = ["all", "movie", "tv", "anime"];
const urlState = () => {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const kind = params.get("dkind") || "";
  return { query: params.get("dq") || "", kind: KINDS.includes(kind) ? kind : "movie" };
};
const label = (title: Title) => title.title || title.name || "Untitled";
const mediaOf = (title: Title) => title.media_type === "movie" || title.media_type === "tv" ? title.media_type : (title.title || title.release_date ? "movie" : "tv");
const poster = (path: string) => `https://image.tmdb.org/t/p/w342${path}`;
const backdropImage = (path: string) => `https://image.tmdb.org/t/p/w780${path}`;
const hasReleased = (title: Title) => {
  const date = mediaOf(title) === "movie" ? title.release_date : title.first_air_date;
  return !date || date <= new Date().toISOString().slice(0, 10);
};

const focusDialog = (element: HTMLElement | null) => element?.focus({ preventScroll: true });

export default function Discover({ query: headerQuery, onQueryChange }: { query?: string; onQueryChange?: (value: string) => void } = {}) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [legacyRequests] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dview") === "requests");
  const [kind, setKind] = useState(() => urlState().kind);
  const [feed, setFeed] = useState("trending");
  const [localQuery, setLocalQuery] = useState(() => urlState().query);
  const query = headerQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const [search, setSearch] = useState(() => urlState().query.trim());
  const [history, setHistory] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [genre, setGenre] = useState("");
  const [year, setYear] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [titles, setTitles] = useState<Title[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedType, setSelectedType] = useState("");
  const [detail, setDetail] = useState<Title | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [matchPath, setMatchPath] = useState("");
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => { const data = await api<Bootstrap>("/bootstrap"); setBootstrap(data); setHistory(data.searches || []); }, []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(1); }, 350); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (search) params.set("dq", search); else params.delete("dq");
    if (legacyRequests) {
      if (!bootstrap) return;
      if (bootstrap.is_admin) { window.location.replace("/admin?section=notifications"); return; }
    }
    params.delete("dview");
    params.set("dkind", kind);
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
  }, [search, kind, bootstrap, legacyRequests]);
  useEffect(() => {
    const restore = () => { const state = urlState(); setQuery(state.query); setSearch(state.query.trim()); setKind(state.kind); setPage(1); };
    window.addEventListener("popstate", restore); return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!search || busy || error) return;
    const timer = window.setTimeout(() => { void api<{ searches: string[] }>("/history", jsonRequest("PUT", { query: search })).then(d => setHistory(d.searches)).catch(() => {}); }, 1500);
    return () => window.clearTimeout(timer);
  }, [search, busy, error]);
  const forget = useCallback(async (term?: string) => {
    try { setHistory((await api<{ searches: string[] }>(`/history${term ? `?q=${encodeURIComponent(term)}` : ""}`, { method: "DELETE" })).searches); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    if (!bootstrap?.configured) return;
    const controller = new AbortController();
    setBusy(true); setError(""); setTitles([]);
    const params = new URLSearchParams({ kind, feed, page: String(page) });
    if (search) params.set("q", search);
    if (genre) params.set("genre", genre);
    if (year) params.set("year", year);
    api<{ results: Title[]; total_pages: number }>(`?${params}`, { signal: controller.signal })
      .then(data => { setTitles(data.results.filter(hasReleased)); setPages(Math.max(1, Math.min(data.total_pages, 500))); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [bootstrap?.configured, kind, feed, page, search, genre, year]);
  useEffect(() => {
    setDetail(null); setMatchPath("");
    if (selected === null) return;
    const controller = new AbortController();
    const catalog = selectedType || (kind === "movie" ? "movie" : "tv");
    api<Title>(`/title/${catalog}/${selected}`, { signal: controller.signal }).then(setDetail).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [selected, selectedType, kind]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelected(null); setHistoryOpen(false); } };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  useBackLayer(historyOpen, () => setHistoryOpen(false));
  useBackLayer(selected !== null, () => setSelected(null));
  const typed = query.trim().toLowerCase();
  const suggestions = history.filter(term => term.toLowerCase() !== typed && (!typed || term.toLowerCase().includes(typed))).slice(0, 8);
  const requestKind = detail ? mediaOf(detail) : selectedType || (kind === "movie" ? "movie" : "tv");
  const matches = (id: number, media = requestKind) => bootstrap?.availability.filter(a => a.tmdb_id === id && a.kind === media) || [];
  const kindLabel = kind === "anime" ? (requestKind === "movie" ? "ANIME MOVIE" : "ANIME SERIES") : requestKind === "tv" ? "SERIES" : "MOVIE";
  const card = (title: Title) => { const media = mediaOf(title); return <button className="discover-card" key={`${media}:${title.id}`} onClick={() => { setSelected(title.id); setSelectedType(media); }}>
    <span className="discover-poster">{title.poster_path ? <CachedArtworkImage src={poster(title.poster_path)} alt="" loading="lazy" /> : <span>No poster</span>}
      {kind === "all" && <i className={media === "movie" ? "movie" : "series"}>{media === "movie" ? "Movie" : "Series"}</i>}
      {matches(title.id, media).length > 0 && <em>{media === "movie" ? "Available" : "Episodes available"}</em>}
    </span><b>{label(title)}</b><small>{kind === "all" ? `${media === "movie" ? "Movie" : "Series"} · ` : ""}{(title.release_date || title.first_air_date || "").slice(0, 4)}{title.vote_average ? ` · ★ ${title.vote_average.toFixed(1)}` : ""}</small>
  </button>; };
  return <div className="discover-panel">
    {error && <p className="discover-error" role="alert">{error}<button onClick={() => { void refresh().catch(e => setError(e.message)); setError(""); }}>Dismiss</button></p>}
    {!bootstrap && !error && <p role="status">Connecting to TMS…</p>}
    {bootstrap && !bootstrap.configured && <div className="discover-empty"><h2>Connect your discovery catalog</h2><p>{bootstrap.can_manage ? "Connect TMDB in Admin’s Discover configuration to browse movies, series, and anime." : "Your administrator needs to connect TMDB before you can browse."}</p>{bootstrap.can_manage && <a className="discover-action" href="/admin?section=discover">Set up Discover in Admin</a>}</div>}
    {bootstrap?.configured && <>
      <div className="discover-controls"><div className="discover-tabs">{[["all", "All"], ["movie", "Movies"], ["tv", "Series"], ["anime", "Anime"]].map(([value, name]) => <button key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); setSelected(null); setGenre(""); if (value !== "anime" && feed === "movies") setFeed("trending"); }}>{name}</button>)}</div>
        {headerQuery === undefined && <div className="discover-search" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHistoryOpen(false); }}>
          <input aria-label="Search Discover" placeholder="Search Discover" value={query} onFocus={() => setHistoryOpen(true)} onChange={e => { setQuery(e.target.value); setHistoryOpen(true); }} />
          {historyOpen && suggestions.length > 0 && <div className="discover-history">
            <header><span>Recent searches</span><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void forget()}>Clear all</button></header>
            {suggestions.map(term => <div className="discover-history-row" key={term}>
              <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setQuery(term); setSearch(term); setPage(1); setHistoryOpen(false); }}>{term}</button>
              <button type="button" aria-label={`Forget ${term}`} onMouseDown={e => e.preventDefault()} onClick={() => void forget(term)}>×</button>
            </div>)}
          </div>}
        </div>}
        <select aria-label="Browse collection" value={feed} onChange={e => { setFeed(e.target.value); setPage(1); }}>
          {kind === "anime" ? <>
            <option value="trending">Trending Series</option>
            <option value="movies">Top Anime Movies</option>
            <option value="popular">Popular Series</option>
            <option value="upcoming">On the air</option>
          </> : <>
            <option value="trending">Trending</option>
            <option value="popular">Popular</option>
            <option value="upcoming">{kind === "movie" ? "Recently released" : kind === "all" ? "Recent movies & on the air" : "On the air"}</option>
          </>}
        </select>
        <button className="discover-filter-toggle" type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{genre || year ? ` (${Number(Boolean(genre)) + Number(Boolean(year))})` : ""}</button>
        {filtersOpen && <div className="discover-extra-filters"><select aria-label="Genre" value={genre} disabled={Boolean(search) || (kind === "anime" && feed === "movies")} onChange={e => { setGenre(e.target.value); setPage(1); }}><option value="">{kind === "anime" ? "Animation (JP)" : "All genres"}</option>{kind !== "anime" && [["35", "Comedy"], ["18", "Drama"], ["16", "Animation"], ["99", "Documentary"], ["9648", "Mystery"]].map(([id,name]) => <option value={id} key={id}>{name}</option>)}</select>
        <input aria-label="Release year" type="number" min="1900" max="2100" placeholder="Year" disabled={Boolean(search)} value={year} onChange={e => { setYear(e.target.value); setPage(1); }} /></div>}
      </div>
      {busy ? <p role="status">Loading titles…</p> : <div className="discover-grid">{titles.map(card)}</div>}
      {!busy && !titles.length && !error && <p className="discover-empty">No titles found. Try another search or filter.</p>}
      {pages > 1 && <div className="discover-pagination"><button disabled={page <= 1 || busy} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page} of {pages}</span><button disabled={page >= pages || busy} onClick={() => setPage(p => p + 1)}>Next</button></div>}
    </>}
    <footer className="discover-credit"><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img src="https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg" alt="TMDB" /></a><span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span></footer>
    {selected !== null && <div className="discover-backdrop" onClick={() => setSelected(null)}><section tabIndex={-1} ref={focusDialog} className="discover-dialog discover-title-dialog" role="dialog" aria-modal="true" aria-label={detail ? label(detail) : "Title details"} onClick={e => e.stopPropagation()}><header className="discover-dialog-header"><h2>{detail ? label(detail) : "Title details"}</h2><button className="discover-close" onClick={() => setSelected(null)} aria-label="Close">×</button></header><div className="discover-dialog-body">{!detail ? <p role="status">Loading details…</p> : <>
      {detail.backdrop_path && <CachedArtworkImage className="discover-detail-backdrop" src={backdropImage(detail.backdrop_path)} alt="" />}<div className={`discover-detail-top${detail.backdrop_path ? " has-backdrop" : ""}`}>{detail.poster_path && <CachedArtworkImage className="discover-detail-poster" src={poster(detail.poster_path)} alt="" />}<div>{detail.backdrop_path && <strong className="discover-detail-heading">{label(detail)}</strong>}<small>{[kindLabel, (detail.release_date || detail.first_air_date || "").slice(0, 4), detail.seasons?.filter(s => s.season_number > 0).length ? `${detail.seasons.filter(s => s.season_number > 0).length} season${detail.seasons.filter(s => s.season_number > 0).length === 1 ? "" : "s"}` : "", detail.vote_average ? `★ ${detail.vote_average.toFixed(1)}` : ""].filter(Boolean).join(" · ")}</small>{!!detail.genres?.length && <p className="discover-detail-genres">{detail.genres.slice(0, 3).map(g => <span key={g.id}>{g.name}</span>)}</p>}<p>{detail.overview || "No description available."}</p>
      {detail.videos?.results.filter(v => v.site === "YouTube" && v.type === "Trailer").slice(0,1).map(v => <a className="discover-action" href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.key)}`} target="_blank" rel="noreferrer" key={v.key}>Watch trailer ↗</a>)}
      {matches(detail.id).map(a => <a className="discover-action" key={a.path} href={`/?folder=${encodeURIComponent(a.path)}`}>Open in {a.path.split('/')[0]}</a>)}
      </div></div>
      {bootstrap && <RequestForm key={`${requestKind}:${detail.id}`} title={detail} kind={requestKind} bootstrap={bootstrap} onSubmitted={()=>{void refresh().catch(e=>setError(e.message));}} />}
      {!!detail.credits?.cast.length && <p className="discover-muted">Cast: {detail.credits.cast.slice(0,8).map(c => c.name).join(", ")}</p>}
      {!!detail.recommendations?.results.filter(hasReleased).length && <><h3>More like this</h3><div className="discover-grid">{detail.recommendations.results.filter(t => t.id !== detail.id && hasReleased(t)).slice(0,6).map(card)}</div></>}
      {bootstrap?.can_manage && <details><summary>Library management · Match existing title</summary><form className="discover-inline" onSubmit={async e => { e.preventDefault(); setSaving(true); try { await api("/match", jsonRequest("PUT", { kind: requestKind, tmdb_id: detail.id, path: matchPath })); await refresh(); setMatchPath(""); } catch(e) { setError((e as Error).message); } finally { setSaving(false); } }}><input aria-label="Existing title path" placeholder="Library/Title folder or movie.mkv" value={matchPath} onChange={e => setMatchPath(e.target.value)} required /><button disabled={saving}>Save match</button></form></details>}
    </>}</div></section></div>}

  </div>;
}
