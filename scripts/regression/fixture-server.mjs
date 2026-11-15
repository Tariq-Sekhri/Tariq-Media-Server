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
    if(url.pathname==='/api/library'||url.pathname==='/api/user-state'){
      const end=res.end.bind(res);
      res.end=(body,...args)=>{try{let value=JSON.parse(String(body));if(url.pathname==='/api/user-state')value.playback={};if(Array.isArray(value))value=value.map(entry=>{const extension=path.extname(entry.path||'').slice(1);return audioSizes[extension]?{...entry,size:audioSizes[extension],duration:12}:entry;});return end(JSON.stringify(value),...args);}catch{return end(body,...args);}};
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
