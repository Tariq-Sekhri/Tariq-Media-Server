"use client";
import { useEffect, useState } from "react";
import { api, jsonRequest } from "./api";
type Service = { kind: string; library: string; url: string; api_key: string; root_folder: string; staging_folder: string; quality_profile_id: number; category: string; enabled: boolean; budget_gb: number; key_configured?: boolean };
type Connection = { version: string; roots: { path:string }[]; profiles: { id:number; name:string; upgradeAllowed?:boolean }[] };
const blank = (kind: string, library: string): Service => ({
  kind,
  library,
  url: kind === "movie" ? "http://127.0.0.1:7878" : "http://127.0.0.1:8989",
  api_key: "",
  root_folder: "",
  staging_folder: "",
  quality_profile_id: 0,
  category: kind === "movie" ? "tms-radarr" : "tms-sonarr",
  enabled: false,
  budget_gb: 50,
});
export default function Services({libraries}:{libraries:string[]}) {
  const preferred = libraries.find(l => /movie|show|tv/i.test(l)) || libraries[0] || "";
  const [saved,setSaved]=useState<Service[]>([]);
  const [draft,setDraft]=useState<Service>(()=>blank("movie", preferred));
  const [connection,setConnection]=useState<Connection|null>(null);
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  const choose=(kind:string,library:string,list:Service[]=saved)=>{
    const old=list.find(s=>s.kind===kind&&s.library===library);
    setDraft(old?{...old,api_key:""}:blank(kind,library));
    setConnection(null);setMessage(old?.key_configured?"Saved API key will be reused for this service.":"");
  };
  useEffect(()=>{
    api<{services:Service[]}>("/services").then(d=>{
      setSaved(d.services);
      const movie=d.services.find(s=>s.kind==="movie"&&s.library===preferred)||d.services.find(s=>s.kind==="movie")||d.services[0];
      if (movie) choose(movie.kind, movie.library, d.services);
      else if (preferred) setDraft(blank("movie", preferred));
    }).catch(e=>setMessage(e.message));
  },[preferred]);
  const patch=(value:Partial<Service>)=>setDraft(old=>({...old,...value}));
  return <details className="discover-service-settings" open><summary>Automatic downloads</summary><p>Connect your movies or shows service to download approved requests. TMS checks your VPN and available storage before downloading.</p><div className="discover-service-grid">
    <label>Service<select value={draft.kind} onChange={e=>choose(e.target.value,draft.library)}><option value="movie">Movie requests</option><option value="tv">Show requests</option></select></label>
    <label>TMS library<select value={draft.library} onChange={e=>choose(draft.kind,e.target.value)}>{libraries.map(l=><option key={l}>{l}</option>)}</select></label>
    <label>Service URL<input value={draft.url} onChange={e=>{patch({url:e.target.value,api_key:"",key_configured:false});setConnection(null);}} /></label>
    <label>API key<input type="password" autoComplete="off" placeholder={draft.key_configured?"Saved — leave blank to keep":"Service API key"} value={draft.api_key} onChange={e=>patch({api_key:e.target.value})}/></label>
    <button type="button" disabled={busy} onClick={async()=>{setBusy(true);setMessage("");try{const data=await api<Connection>("/services/test",jsonRequest("POST",draft));setConnection(data);const profile=data.profiles.find(p=>p.name==="HD-1080p"&&!p.upgradeAllowed)||data.profiles.find(p=>!p.upgradeAllowed);if(profile&&!draft.quality_profile_id)patch({quality_profile_id:profile.id});if(data.roots[0]&&!draft.root_folder)patch({root_folder:data.roots[0].path});setMessage(`Connected · version ${data.version}`);}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}}>Test connection and load profiles</button>
    <label>Root folder{connection?<select value={draft.root_folder} onChange={e=>patch({root_folder:e.target.value})}><option value="">Choose a root</option>{connection.roots.map(r=><option key={r.path}>{r.path}</option>)}</select>:<input value={draft.root_folder} onChange={e=>patch({root_folder:e.target.value})} placeholder="Same physical folder as the TMS library"/>}</label>
    <label>Download staging folder<input value={draft.staging_folder} onChange={e=>patch({staging_folder:e.target.value})} placeholder="qBittorrent category save folder"/></label>
    <label>Quality profile{connection?<select value={draft.quality_profile_id} onChange={e=>patch({quality_profile_id:Number(e.target.value)})}><option value={0}>Choose a profile</option>{connection.profiles.map(p=><option value={p.id} key={p.id} disabled={p.upgradeAllowed}>{p.name}{p.upgradeAllowed?" · upgrades enabled":""}</option>)}</select>:<input type="number" value={draft.quality_profile_id} onChange={e=>patch({quality_profile_id:Number(e.target.value)})}/>}</label>
    <label>qBittorrent category<input value={draft.category} onChange={e=>patch({category:e.target.value})}/></label>
    <label>Budget per movie / season (GiB)<input type="number" min={1} max={1000} value={draft.budget_gb} onChange={e=>patch({budget_gb:Number(e.target.value)})}/></label>
    <label><input type="checkbox" checked={draft.enabled} onChange={e=>patch({enabled:e.target.checked})}/> Enable automatic requests for this library</label>
    <button type="button" disabled={busy||!draft.library} onClick={async()=>{setBusy(true);setMessage("");try{await api("/services",jsonRequest("PUT",draft));const config=await api<{services:Service[]}>("/services");setSaved(config.services);setDraft(old=>({...old,api_key:"",key_configured:true}));setMessage(draft.enabled?"Service enabled and saved.":"Service settings saved.");}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}}>Save service</button>
  </div>{message&&<p role="status">{message}</p>}</details>;
}
