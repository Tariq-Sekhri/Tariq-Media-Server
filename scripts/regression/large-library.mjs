// Large-library load test for the Android app (regression build).
//
// Needs: the regression app installed on a dedicated emulator, a current
// regression client build, and the fixture server started with
// TMS_REGRESSION_LIBRARY_SIZE (for example 48000) on loopback port 3100.
//
//   node scripts/regression/large-library.mjs --serial emulator-5554 [--cpu 4] [--runs 3] [--timeout 180000] [--output file.json]
//
// Each run reloads the WebView document at `/` and measures, in wall time from
// the navigation:
//   first_cards_ms   any library card is visible
//   library_ready_ms the server library is applied (the synthetic library card
//                    is visible and the app reported library_server_load)
//   folder_open_ms   tapping that library card shows its folders
//   max_blocked_ms   longest main-thread stall seen by a frame-gap monitor
//   blocked_total_ms total time in long tasks (> 50 ms)
// "cold" clears IndexedDB, Cache Storage, service workers and session storage
// first. "warm" keeps the cache written by the previous run, like reopening
// the app. A stage that does not finish inside --timeout is reported as such.
import {attach} from './cdp.mjs';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const serial=args.get('--serial');assert.match(serial||'',/^emulator-\d+$/,'Supply --serial for the dedicated emulator');
const cpu=Number(args.get('--cpu')??4),runs=Number(args.get('--runs')??3),timeout=Number(args.get('--timeout')??180000);
const origin='http://127.0.0.1:3100',BULK='Bulk Library';
const packageName='ca.sekhrit.tms.regression';
const adb=(...a)=>execFileSync('adb',['-s',serial,...a],{encoding:'utf8'}).trim();

const ready=await fetch(origin+'/regression-ready').then(r=>r.json()).catch(()=>null);
assert.ok(ready,'Start the fixture server first');
const libraryCount=await fetch(origin+'/api/library?sort=opened&direction=desc',{headers:{Authorization:'Bearer demo-token'}}).then(r=>r.json()).then(e=>e.length);
assert.ok(libraryCount>10000,`Fixture library is too small (${libraryCount}); set TMS_REGRESSION_LIBRARY_SIZE`);

// Installed before any app script: frame-gap and long-task monitors, plus a
// copy of the app's own performance telemetry.
const monitor=`(()=>{const s=window.__tmsLoad={maxGap:0,longTotal:0,longMax:0,phases:{}};let last=performance.now();const frame=t=>{const gap=t-last;if(gap>s.maxGap)s.maxGap=gap;last=t;requestAnimationFrame(frame);};requestAnimationFrame(frame);
try{new PerformanceObserver(l=>{for(const e of l.getEntries()){s.longTotal+=e.duration;if(e.duration>s.longMax)s.longMax=e.duration;}}).observe({type:'longtask',buffered:true});}catch{}
const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u,...r){this.__u=String(u);return open.call(this,m,u,...r);};
XMLHttpRequest.prototype.send=function(b){try{if(this.__u&&this.__u.includes('/api/client-performance')){const p=JSON.parse(b);(s.phases[p.event]??=[]).push({at:performance.now(),duration:p.duration_ms,details:p.details});}}catch{}return send.call(this,b);};})();`;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){
  adb('shell','am','force-stop',packageName);
  adb('shell','am','start','-W','-f','0x10008000','-n',`${packageName}/ca.sekhrit.tms.TmsConnectionActivity`);
  const c=await attach(serial,packageName);
  await c.call('Page.enable');
  await c.call('Page.addScriptToEvaluateOnNewDocument',{source:monitor});
  await c.call('Emulation.setCPUThrottlingRate',{rate:cpu});
  return c;
}
// Polls until `expression` is true. Each poll waits on the page's main
// thread, so a frozen page delays the result exactly as it delays the user.
async function until(c,expression,deadline){
  while(Date.now()<deadline){
    try{if(await Promise.race([c.evaluate(expression),sleep(Math.max(1,deadline-Date.now())).then(()=>false)]))return true;}catch{}
    await sleep(50);
  }
  return false;
}
// Cards link to `?folder=<path>`; match on that path, not the label text.
const cardFor=folder=>`[...document.querySelectorAll('a.card-label-link')].find(e=>{const r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return false;${folder?`try{return new URL(e.href).searchParams.get('folder')===${JSON.stringify(folder)};}catch{return false;}`:'return true;'}})`;
const visibleCard=folder=>`!!${cardFor(folder)}`;

async function measure(c,mode){
  if(mode==='cold'){
    await c.call('Page.navigate',{url:origin+'/regression-ready'});
    await until(c,`location.pathname==='/regression-ready'&&document.readyState==='complete'`,Date.now()+30000);
    await c.evaluate('sessionStorage.clear()');
    await c.call('Storage.clearDataForOrigin',{origin,storageTypes:'indexeddb,cache_storage,service_workers'});
  }
  const result={mode,cpu_throttle:cpu,library_entries:libraryCount};
  const start=Date.now(),deadline=start+timeout;
  await c.call('Page.navigate',{url:origin+'/'});
  result.first_cards_ms=await until(c,visibleCard(),deadline)?Date.now()-start:null;
  result.library_ready_ms=await until(c,`${visibleCard(BULK)}&&!!window.__tmsLoad?.phases.library_server_load`,deadline)?Date.now()-start:null;
  if(result.library_ready_ms!==null){
    const tapStart=Date.now();
    const clicked=await c.evaluate(`(()=>{const e=${cardFor(BULK)};if(!e)return false;e.click();return true;})()`);
    assert.ok(clicked,'Library card disappeared before it could be opened');
    result.folder_open_ms=await until(c,`location.search.includes('folder=')&&${visibleCard(BULK+'/Collection 0001')}`,tapStart+timeout)?Date.now()-tapStart:null;
  } else result.folder_open_ms=null;
  const stats=await Promise.race([c.evaluate('window.__tmsLoad'),sleep(30000).then(()=>null)]);
  result.max_blocked_ms=stats?Math.round(stats.maxGap):null;
  result.blocked_total_ms=stats?Math.round(stats.longTotal):null;
  const server=stats?.phases.library_server_load?.at(-1);
  result.app_reported={library_server_load_ms:server?.duration??null,api_wait_ms:server?.details?.api_wait_ms??null,cache_read_ms:server?.details?.cache_read_ms??null,library_load_complete_ms:stats?.phases.library_load_complete?.at(-1)?.duration??null};
  result.timed_out=result.library_ready_ms===null||result.folder_open_ms===null;
  return result;
}

const results=[];
for(let run=1;run<=runs;run++)for(const mode of ['cold','warm']){
  let c;
  try{
    c=await launch();
    // The launch itself loaded `/`; the cold run clears what it cached and
    // the warm run reloads on top of the cache from the previous cold run.
    const r={run,...await measure(c,mode)};
    results.push(r);console.log(JSON.stringify(r));
  }catch(error){results.push({run,mode,error:error.message});console.log(JSON.stringify(results.at(-1)));}
  finally{try{await c?.call('Emulation.setCPUThrottlingRate',{rate:1});}catch{}c?.close();}
}
const median=values=>{const v=values.filter(x=>typeof x==='number').sort((a,b)=>a-b);if(!v.length)return null;const m=Math.floor(v.length/2);return v.length%2?v[m]:Math.round((v[m-1]+v[m])/2);};
const summary={};
for(const mode of ['cold','warm']){
  const rows=results.filter(r=>r.mode===mode&&!r.error);
  summary[mode]={runs:rows.length,timeouts:rows.filter(r=>r.timed_out).length,errors:results.filter(r=>r.mode===mode&&r.error).length};
  for(const key of ['first_cards_ms','library_ready_ms','folder_open_ms','max_blocked_ms','blocked_total_ms'])summary[mode][key]=median(rows.map(r=>r[key]));
}
const report={serial,cpu_throttle:cpu,timeout_ms:timeout,library_entries:libraryCount,summary,results};
if(args.get('--output'))await writeFile(args.get('--output'),JSON.stringify(report,null,2));
console.log(JSON.stringify({summary},null,2));
if(Object.values(summary).some(s=>s.timeouts||s.errors))process.exitCode=1;
