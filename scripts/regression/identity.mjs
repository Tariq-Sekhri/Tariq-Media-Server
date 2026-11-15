import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const hash=data=>createHash('sha256').update(data).digest('hex');
const digest=entries=>hash(entries.join('\n'));
// Code-unit ordering, so the identity never depends on the host locale.
const byPath=(a,b)=>a<b?-1:a>b?1:0;
// Every regular file below `dir`, as sorted POSIX paths relative to `base`.
export async function listFiles(dir,base=dir){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...await listFiles(file,base));
    else if(entry.isFile())out.push(path.relative(base,file).replaceAll('\\','/'));
  }
  return out.sort(byPath);
}
const fileEntries=async(root,files)=>Promise.all(files.map(async f=>`${f}:${hash(await readFile(path.join(root,f)))}`));
// Everything `npm run build` (vinext build + scripts/build-app-shell.mjs) reads:
// app code, every public/ file (index.html, service-worker.js and the copied
// static assets), dependency versions and patches, and build configuration.
export const sourceTrees=['app','public','patches'];
export const sourceFiles=['package.json','package-lock.json','vite.config.ts','next.config.ts','tsconfig.json','scripts/build-app-shell.mjs'];
export async function sourceIdentity(root='.'){
  const trees=(await Promise.all(sourceTrees.map(async dir=>(await listFiles(path.join(root,dir))).map(f=>`${dir}/${f}`)))).flat();
  return digest(await fileEntries(root,[...trees,...sourceFiles].sort(byPath)));
}
export async function fixtureIdentity(){return digest(await Promise.all(['demo/mock-backend.ts','scripts/regression/fixture-server.mjs','private/regression-media.webm','private/regression-tone.mp3','private/regression-tone.m4a'].map(async f=>`${f}:${hash(await readFile(f))}`)));}
// The whole served release: every file under dist/client (assets, service
// worker, manifests, HTML). The stamp written after hashing is excluded.
export const buildStampFile='regression-build.json';
export async function buildIdentity(dir='dist/client'){
  const files=(await listFiles(dir)).filter(f=>f!==buildStampFile);
  if(!files.includes('index.html'))throw Error('Built client has no index.html');
  return digest(await fileEntries(dir,files));
}
