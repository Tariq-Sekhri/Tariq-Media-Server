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
const GENRES: [string, string][] = [["action", "Action"], ["adventure", "Adventure"], ["animation", "Animation"], ["comedy", "Comedy"], ["crime", "Crime"], ["documentary", "Documentary"], ["drama", "Drama"], ["family", "Family"], ["fantasy", "Fantasy"], ["history", "History"], ["horror", "Horror"], ["kids", "Kids"], ["music", "Music"], ["mystery", "Mystery"], ["reality", "Reality"], ["romance", "Romance"], ["science-fiction", "Sci-fi"], ["thriller", "Thriller"], ["war", "War"], ["western", "Western"]];
const SORTS: [string, string][] = [["trending", "Trending"], ["popular", "Popular"], ["rating", "Top rated"], ["votes", "Most voted"], ["newest", "Newest"], ["oldest", "Oldest"], ["title", "Title A–Z"]];
const LANGUAGES: [string, string][] = [["en", "English"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["hi", "Hindi"], ["fr", "French"], ["es", "Spanish"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ru", "Russian"], ["sv", "Swedish"], ["da", "Danish"], ["tr", "Turkish"], ["th", "Thai"]];
type Filters = { type: string; sort: string; genres: string[]; yearFrom: string; yearTo: string; rating: string; votes: string; runtimeMin: string; runtimeMax: string; lang: string };
const EMPTY_FILTERS: Filters = { type: "", sort: "trending", genres: [], yearFrom: "", yearTo: "", rating: "", votes: "", runtimeMin: "", runtimeMax: "", lang: "" };
const FILTER_URL: [keyof Filters, string][] = [["type", "dtype"], ["sort", "dsort"], ["yearFrom", "dyf"], ["yearTo", "dyt"], ["rating", "dr"], ["votes", "dv"], ["runtimeMin", "drmin"], ["runtimeMax", "drmax"], ["lang", "dl"]];
const urlState = () => {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const filters: Filters = { ...EMPTY_FILTERS, genres: (params.get("dg") || "").split(",").filter(g => GENRES.some(([id]) => id === g)) };
  for (const [key, param] of FILTER_URL) (filters[key] as string) = params.get(param) || EMPTY_FILTERS[key] as string;
  if (!["", "movie", "tv"].includes(filters.type)) filters.type = "";
  if (!SORTS.some(([id]) => id === filters.sort)) filters.sort = "trending";
  return { query: params.get("dq") || "", filters };
};
const activeFilterCount = (f: Filters) => [f.type, f.genres.length ? "g" : "", f.yearFrom || f.yearTo, f.rating, f.votes, f.runtimeMin || f.runtimeMax, f.lang].filter(Boolean).length;
const label = (title: Title) => title.title || title.name || "Untitled";
const mediaOf = (title: Title) => title.media_type === "movie" || title.media_type === "tv" ? title.media_type : (title.title || title.release_date ? "movie" : "tv");
const poster = (path: string) => `https://image.tmdb.org/t/p/w342${path}`;
const backdropImage = (path: string) => `https://image.tmdb.org/t/p/w780${path}`;
const hasReleased = (title: Title) => {
  const date = mediaOf(title) === "movie" ? title.release_date : title.first_air_date;
  return !date || date <= new Date().toISOString().slice(0, 10);
};

const focusDialog = (element: HTMLElement | null) => element?.focus({ preventScroll: true });

export default function Discover() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [legacyRequests] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dview") === "requests");
  const [filters, setFilterState] = useState(() => urlState().filters);
  const [query, setQuery] = useState(() => urlState().query);
  const [search, setSearch] = useState(() => urlState().query.trim());
  const [history, setHistory] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const setFilters = (patch: Partial<Filters>) => { setFilterState(current => ({ ...current, ...patch })); setPage(1); };
  const toggleGenre = (id: string) => setFilters({ genres: filters.genres.includes(id) ? filters.genres.filter(g => g !== id) : [...filters.genres, id] });
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
    params.delete("dkind");
    for (const [key, param] of FILTER_URL) { const value = filters[key] as string; if (value && value !== EMPTY_FILTERS[key]) params.set(param, value); else params.delete(param); }
    if (filters.genres.length) params.set("dg", filters.genres.join(",")); else params.delete("dg");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
  }, [search, filters, bootstrap, legacyRequests]);
  useEffect(() => {
    const restore = () => { const state = urlState(); setQuery(state.query); setSearch(state.query.trim()); setFilterState(state.filters); setPage(1); };
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
    const params = new URLSearchParams({ page: String(page), sort: filters.sort });
    if (search) params.set("q", search);
    if (filters.type) params.set("type", filters.type);
    if (filters.genres.length) params.set("genres", filters.genres.join(","));
    if (filters.yearFrom) params.set("year_from", filters.yearFrom);
    if (filters.yearTo) params.set("year_to", filters.yearTo);
    if (filters.rating) params.set("rating", filters.rating);
    if (filters.votes) params.set("votes", filters.votes);
    if (filters.runtimeMin) params.set("runtime_min", filters.runtimeMin);
    if (filters.runtimeMax) params.set("runtime_max", filters.runtimeMax);
    if (filters.lang) params.set("lang", filters.lang);
    api<{ results: Title[]; total_pages: number }>(`?${params}`, { signal: controller.signal })
      .then(data => { setTitles(data.results.filter(hasReleased)); setPages(Math.max(1, Math.min(data.total_pages, 500))); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [bootstrap?.configured, filters, page, search]);
  useEffect(() => {
    setDetail(null); setMatchPath("");
    if (selected === null) return;
    const controller = new AbortController();
    api<Title>(`/title/${selectedType || "movie"}/${selected}`, { signal: controller.signal }).then(setDetail).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [selected, selectedType]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelected(null); setHistoryOpen(false); } };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  useBackLayer(historyOpen, () => setHistoryOpen(false));
  useBackLayer(selected !== null, () => setSelected(null));
  const typed = query.trim().toLowerCase();
  const suggestions = history.filter(term => term.toLowerCase() !== typed && (!typed || term.toLowerCase().includes(typed))).slice(0, 8);
  const requestKind = detail ? mediaOf(detail) : selectedType || "movie";
  const matches = (id: number, media = requestKind) => bootstrap?.availability.filter(a => a.tmdb_id === id && a.kind === media) || [];
  const kindLabel = requestKind === "tv" ? "SERIES" : "MOVIE";
  const filterCount = activeFilterCount(filters);
  const card = (title: Title) => { const media = mediaOf(title); return <button className="discover-card" key={`${media}:${title.id}`} onClick={() => { setSelected(title.id); setSelectedType(media); }}>
    <span className="discover-poster">{title.poster_path ? <CachedArtworkImage src={poster(title.poster_path)} alt="" loading="lazy" /> : <span>No poster</span>}
      {!filters.type && <i className={media === "movie" ? "movie" : "series"}>{media === "movie" ? "Movie" : "Series"}</i>}
      {matches(title.id, media).length > 0 && <em>{media === "movie" ? "Available" : "Episodes available"}</em>}
    </span><b>{label(title)}</b><small>{(title.release_date || title.first_air_date || "").slice(0, 4)}{title.vote_average ? ` · ★ ${title.vote_average.toFixed(1)}` : ""}</small>
  </button>; };
  return <div className="discover-panel">
    {error && <p className="discover-error" role="alert">{error}<button onClick={() => { void refresh().catch(e => setError(e.message)); setError(""); }}>Dismiss</button></p>}
    {!bootstrap && !error && <p role="status">Connecting to TMS…</p>}
    {bootstrap && !bootstrap.configured && <div className="discover-empty"><h2>Connect your discovery catalog</h2><p>{bootstrap.can_manage ? "Connect TMDB in Admin’s Discover configuration to browse movies and series." : "Your administrator needs to connect TMDB before you can browse."}</p>{bootstrap.can_manage && <a className="discover-action" href="/admin?section=discover">Set up Discover in Admin</a>}</div>}
    {bootstrap?.configured && <>
      <div className="discover-controls">
        <div className="discover-search" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHistoryOpen(false); }}>
          <input type="search" aria-label="Search movies and series" placeholder="Search movies and series" value={query} onFocus={() => setHistoryOpen(true)} onChange={e => { setQuery(e.target.value); setHistoryOpen(true); }} onKeyDown={e => { if (e.key === "Enter") { setSearch(query.trim()); setPage(1); setHistoryOpen(false); } }} />
          {historyOpen && suggestions.length > 0 && <div className="discover-history">
            <header><span>Recent searches</span><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => void forget()}>Clear all</button></header>
            {suggestions.map(term => <div className="discover-history-row" key={term}>
              <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setQuery(term); setSearch(term); setPage(1); setHistoryOpen(false); }}>{term}</button>
              <button type="button" aria-label={`Forget ${term}`} onMouseDown={e => e.preventDefault()} onClick={() => void forget(term)}>×</button>
            </div>)}
          </div>}
        </div>
        <select aria-label="Sort titles" value={filters.sort} onChange={e => setFilters({ sort: e.target.value })}>{SORTS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <button className={`discover-filter-toggle${filterCount ? " active" : ""}`} type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{filterCount ? ` · ${filterCount}` : ""}</button>
      </div>
      {filtersOpen && <div className="discover-filters">
        <fieldset><legend>Type</legend><div className="discover-segment">{[["", "All"], ["movie", "Movies"], ["tv", "Series"]].map(([id, name]) => <button key={id} type="button" className={filters.type === id ? "active" : ""} aria-pressed={filters.type === id} onClick={() => setFilters({ type: id })}>{name}</button>)}</div></fieldset>
        <fieldset><legend>Release year</legend><div className="discover-range"><input type="number" inputMode="numeric" min="1900" max="2100" placeholder="From" aria-label="Released from year" value={filters.yearFrom} onChange={e => setFilters({ yearFrom: e.target.value })} /><span>–</span><input type="number" inputMode="numeric" min="1900" max="2100" placeholder="To" aria-label="Released until year" value={filters.yearTo} onChange={e => setFilters({ yearTo: e.target.value })} /></div></fieldset>
        <fieldset><legend>TMDB rating</legend><select aria-label="Minimum rating" value={filters.rating} onChange={e => setFilters({ rating: e.target.value })}><option value="">Any</option>{[5, 6, 7, 7.5, 8, 8.5, 9].map(r => <option key={r} value={r}>{r}+</option>)}</select></fieldset>
        <fieldset><legend>Votes</legend><select aria-label="Minimum votes" value={filters.votes} onChange={e => setFilters({ votes: e.target.value })}><option value="">Any</option>{[50, 500, 1000, 5000, 10000, 25000].map(v => <option key={v} value={v}>{v.toLocaleString()}+</option>)}</select></fieldset>
        <fieldset><legend>Runtime (min)</legend><div className="discover-range"><input type="number" inputMode="numeric" min="0" max="600" placeholder="Min" aria-label="Minimum runtime in minutes" value={filters.runtimeMin} onChange={e => setFilters({ runtimeMin: e.target.value })} /><span>–</span><input type="number" inputMode="numeric" min="0" max="600" placeholder="Max" aria-label="Maximum runtime in minutes" value={filters.runtimeMax} onChange={e => setFilters({ runtimeMax: e.target.value })} /></div></fieldset>
        <fieldset><legend>Original language</legend><select aria-label="Original language" value={filters.lang} onChange={e => setFilters({ lang: e.target.value })}><option value="">Any</option>{LANGUAGES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></fieldset>
        <fieldset className="discover-genres"><legend>Genres{filters.genres.length > 1 ? " · all must match" : ""}</legend><div>{GENRES.map(([id, name]) => <button key={id} type="button" className={filters.genres.includes(id) ? "active" : ""} aria-pressed={filters.genres.includes(id)} onClick={() => toggleGenre(id)}>{name}</button>)}</div></fieldset>
        {filterCount > 0 && <button type="button" className="discover-filters-reset" onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort })}>Clear filters</button>}
      </div>}
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
