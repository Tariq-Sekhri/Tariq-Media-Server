// Real compiled React screens against synthetic HTTP data. This is client
// integration, not a substitute for Rust HTTP/auth/media integration coverage.
import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {demoBackend} from '../../demo/mock-backend.ts';
import {sourceIdentity,fixtureIdentity,buildIdentity} from './identity.mjs';
const root = path.resolve('dist/client');
const port = Number(process.env.TMS_REGRESSION_PORT || 3100);
const handlers = [];
const buildStamp=JSON.parse(await readFile('dist/client/regression-build.json','utf8'));
if(buildStamp.source!==await sourceIdentity()||buildStamp.build!==await buildIdentity())throw Error('Rebuild the regression client from the current source');
const fixtureStamp=await fixtureIdentity();
let unavailable=false;
const audioSizes={mp3:(await stat('private/regression-tone.mp3')).size,m4a:(await stat('private/regression-tone.m4a')).size};
demoBackend().configureServer({middlewares:{use(fn){handlers.push(fn);}}});
// TMS_REGRESSION_LIBRARY_SIZE adds a synthetic library of that many entries,
// shaped like a large real one: recursive root listing, thousands of tagged
// paths and playback records. Names are generic placeholders.
const bulkSize=Number(process.env.TMS_REGRESSION_LIBRARY_SIZE||0);
const BULK='Bulk Library';
const bulk=(()=>{
  if(!bulkSize)return null;
  const perFolder=120,folders=Math.max(1,Math.ceil(bulkSize/(perFolder+1))),now=1790000000,entries=[],children=new Map();
  const tags={},lastAccessed={},playback={},favorites=[];
  entries.push({path:BULK,device_path:null,name:BULK,kind:'folder',preview_path:null,preview_kind:null,item_count:folders,catalog_kind:null,catalog_title_path:null,size:0,created_at:now,duration:null,thumbnail_aspect_ratio:null});
  for(let f=0;f<folders&&entries.length<bulkSize;f++){
    const folder=`${BULK}/Collection ${String(f+1).padStart(4,'0')}`,files=[];
    entries.push({path:folder,device_path:null,name:folder.split('/').at(-1),kind:'folder',preview_path:`${folder}/clip-0001.mp4`,preview_kind:'video',item_count:perFolder,catalog_kind:null,catalog_title_path:null,size:0,created_at:now-f*600,duration:null,thumbnail_aspect_ratio:null});
    for(let i=1;i<=perFolder&&entries.length<bulkSize;i++){
      const video=i%3!==0,path=`${folder}/clip-${String(i).padStart(4,'0')}.${video?'mp4':'jpg'}`;
      const entry={path,device_path:null,name:path.split('/').at(-1),kind:'file',preview_path:null,preview_kind:null,item_count:null,catalog_kind:null,catalog_title_path:null,size:2000000+i*1000,created_at:now-f*600-i,duration:video?15+i%60:null,thumbnail_aspect_ratio:video?9/16:3/4};
      entries.push(entry);files.push(entry);
      const n=entries.length;
      if(n%3===0)tags[path]=n%2?['Video']:['Video','Saved'];
      if(n%60===0)lastAccessed[path]=now-n;
      if(n%65===0)playback[path]={position:5,duration:30,updated:now-n};
      if(n%1200===0)favorites.push(path);
    }
    children.set(folder,files);
  }
  children.set(BULK,entries.filter(e=>e.kind==='folder'&&e.path!==BULK));
  return {entries,children,userState:{tags,last_accessed:lastAccessed,playback,favorites}};
})();
const sendJson=(res,value,headers={})=>res.writeHead(200,{'Content-Type':'application/json',...headers}).end(JSON.stringify(value));
function tone() {
  const rate=16000, samples=rate*12, b=Buffer.alloc(44+samples*2);
  b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(rate,24); b.writeUInt32LE(rate*2,28); b.writeUInt16LE(2,32);
  b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*4000),44+i*2);
  return b;
}
const wav=tone();
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.webm':'video/webm'};
function ranged(req,res,data,type){
  const m=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start=m?Number(m[1]):0,end=m&&m[2]?Math.min(Number(m[2]),data.length-1):data.length-1;
  if(start>=data.length||end<start){res.writeHead(416,{'Content-Range':`bytes */${data.length}`}).end();return;}
  res.writeHead(m?206:200,{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'public, max-age=3600',...(m?{'Content-Range':`bytes ${start}-${end}/${data.length}`}:{})});
  res.end(req.method==='HEAD'?undefined:data.subarray(start,end+1));
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/regression-ready'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({fixtureVersion:fixtureStamp,...buildStamp,frontend:'compiled-shared-react'}));return;}
    if(url.pathname==='/regression/control'&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const control=JSON.parse(body||'{}');unavailable=control.offline===true;res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({offline:unavailable}));return;}
    if(unavailable&&(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/'))){res.writeHead(503).end('Synthetic outage');return;}
    if(url.pathname.startsWith('/media/')&&/\.(mp3|m4a)$/i.test(url.pathname)){const extension=path.extname(url.pathname).slice(1);ranged(req,res,await readFile(`private/regression-tone.${extension}`),extension==='mp3'?'audio/mpeg':'audio/mp4');return;}
    if(url.pathname.startsWith('/media/')&&/\.wav$/i.test(url.pathname)){ranged(req,res,wav,'audio/wav');return;}
    if(url.pathname.startsWith('/media/')&&/\.(mkv|mp4|webm)$/i.test(url.pathname)){ranged(req,res,await readFile('private/regression-media.webm'),'video/webm');return;}
    const folderParam=url.searchParams.get('folder');
    if(bulk&&url.pathname==='/api/library'&&folderParam&&(folderParam===BULK||folderParam.startsWith(BULK+'/'))){const page=bulk.children.get(folderParam)||[];sendJson(res,page,{'x-tms-total':String(page.length),'x-tms-has-more':'false','x-tms-consumed':String(page.length)});return;}
    if(url.pathname==='/api/library'||url.pathname==='/api/user-state'||(bulk&&url.pathname==='/api/libraries')){
      const end=res.end.bind(res);
      res.end=(body,...args)=>{try{let value=JSON.parse(String(body));if(url.pathname==='/api/user-state')value.playback={};
        if(bulk&&url.pathname==='/api/libraries')value[BULK]={content_type:'mixed',members:[{name:'Demo',can_view:true,can_delete:true,can_move:true,can_create_folders:true,can_upload:true,can_download:true,can_rename:true}],title_folders:[],trickplay_enabled:false,folder_structure_static:false};
        if(bulk&&url.pathname==='/api/user-state')value={...value,tags:{...value.tags,...bulk.userState.tags},last_accessed:{...value.last_accessed,...bulk.userState.last_accessed},playback:{...bulk.userState.playback},favorites:[...value.favorites,...bulk.userState.favorites]};
        if(bulk&&url.pathname==='/api/library'&&!folderParam&&!url.searchParams.get('under')&&Array.isArray(value))value=[...value,...bulk.entries];if(Array.isArray(value))value=value.map(entry=>{const extension=path.extname(entry.path||'').slice(1);return audioSizes[extension]?{...entry,size:audioSizes[extension],duration:12}:entry;});return end(JSON.stringify(value),...args);}catch{return end(body,...args);}};
    }
    for(const fn of handlers){let next=false;fn(req,res,()=>{next=true;});if(!next)return;}
    const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file=path.resolve(root,relative);
    if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    try{if(!(await stat(file)).isFile())throw Error();}catch{file=path.join(root,'index.html');}
    let body=await readFile(file);
    if(file===path.join(root,'index.html'))body=Buffer.from(body.toString().replace('<head>',`<head><meta name="tms-regression-build" content="${buildStamp.build}">`));
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(500).end('Regression fixture unavailable');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Regression fixture ready on loopback port ${port}`));
