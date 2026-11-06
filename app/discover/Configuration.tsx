"use client";
import { useCallback, useEffect, useState } from "react";
import { api, jsonRequest } from "./api";
import { RequestPermissions } from "./Requests";
import Services from "./Services";
import type { Bootstrap } from "./Discover";

export default function DiscoverConfiguration() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => setBootstrap(await api<Bootstrap>("/bootstrap")), []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  if (!bootstrap) return <p role="status">{error || "Loading Discover configurationâ€¦"}</p>;
  if (!bootstrap.can_manage) return <p>Discover configuration requires administrator access.</p>;
  return <div className="discover-panel discover-settings discover-configuration"><><p role="status">{bootstrap?.configured ? "TMDB configured" : "Connect TMDB to browse movies and shows."}</p>{error&&<p className="discover-error" role="alert">{error}</p>}<form onSubmit={async e => { e.preventDefault(); setSaving(true); try { await api("/settings", jsonRequest("PUT", { tmdb_token: token })); setToken(""); await refresh(); setError(""); } catch(e) { setError((e as Error).message); } finally { setSaving(false); } }}><label>{bootstrap?.configured ? "Replace TMDB token" : "TMDB access token"}<input autoFocus={!bootstrap?.configured} type="password" autoComplete="off" placeholder={bootstrap?.configured ? "Token saved Â· enter a new one to replace it" : "Paste your TMDB read access token"} value={token} onChange={e => setToken(e.target.value)} required /></label><button disabled={saving || !token.trim()}>Save token</button><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get a TMDB token â†—</a></form><button disabled={saving||!bootstrap?.configured} onClick={async()=>{setSaving(true);try{const result=await api<{added:number;unmatched:number}>("/match/backfill",{method:"POST"});await refresh();setError(`Matched ${result.added} titles from cached metadata. ${result.unmatched} need a manual match.`);}catch(e){setError((e as Error).message);}finally{setSaving(false);}}}>Match existing library titles</button></>{bootstrap&&<><details className="discover-advanced-services"><summary>Download services</summary><Services libraries={bootstrap.libraries}/></details>{bootstrap.is_admin && <RequestPermissions libraries={bootstrap.libraries} />}</>}</div>;
}

