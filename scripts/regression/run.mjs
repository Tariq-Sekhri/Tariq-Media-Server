import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import {attach} from './cdp.mjs';
import {sourceIdentity,fixtureIdentity,buildIdentity} from './identity.mjs';
import {createHash} from 'node:crypto';
const require = createRequire(import.meta.url);
const { probe } = require('./probe.cjs');
const { assess, budgets } = require('./budgets.cjs');
const {referenceExpression,viewportExpression,verifyScreens}=require('./pixels.cjs');
const args = new Map();
for (let i=2; i<process.argv.length; i+=2) { assert.ok(process.argv[i].startsWith('--') && process.argv[i+1], 'Arguments require values'); args.set(process.argv[i],process.argv[i+1]); }
const serial = args.get('--serial'), configPath = args.get('--config');
assert.ok(serial && configPath, '--serial and --config are required');
const config = JSON.parse(await readFile(configPath,'utf8'));
if(args.get('--only'))config.scenarios=config.scenarios.filter(s=>s.id===args.get('--only'));
assert.ok(Array.isArray(config.scenarios) && config.scenarios.length, 'Scenarios are required');
const attempts = Number(config.attempts ?? 3);
assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 100, 'Invalid attempts');
for (const s of config.scenarios) {
  assert.ok(typeof s.id === 'string' && s.id && budgets[s.budget] && ['image','video','audio','element'].includes(s.kind), 'Invalid scenario');
  assert.ok(s.clickSelector && s.resultSelector, 'Selectors required');
  if (s.kind !== 'element') assert.ok(typeof s.sourceIncludes === 'string' && s.sourceIncludes.length > 0, 'Media requires an expected sourceIncludes');
  assert.ok(s.timeoutMs === undefined || (Number.isFinite(s.timeoutMs) && s.timeoutMs > 0 && s.timeoutMs <= 23000), 'Invalid timeoutMs');
}
const packageName=args.get('--package')||'ca.sekhrit.tms.regression';
assert.equal(packageName,'ca.sekhrit.tms.regression','Fixture runs require the isolated regression app');
const connection=await attach(serial,packageName);
const {call}=connection;
const digest=value=>createHash('sha256').update(value).digest('hex');
const runtimeProfile=digest(['getprop ro.build.version.sdk','wm size','wm density'].map(command=>execFileSync('adb',['-s',serial,'shell',command],{encoding:'utf8'})).join('\n'));
const methodIdentity=Buffer.concat(await Promise.all(['scripts/regression/run.mjs','scripts/regression/probe.cjs','scripts/regression/pixels.cjs'].map(p=>readFile(p))));
let buildId,fixture;
let audioMonitor;
const audioFile=path.resolve('private/regression-audio-events.jsonl');
const runId=String(Date.now());
const evidenceDirectory=path.join(args.get('--evidence-dir')||'private/performance-evidence',runId);
try {
  buildId=await buildIdentity();
  fixture=await (await fetch('http://127.0.0.1:3100/regression-ready',{signal:AbortSignal.timeout(5000)})).json();
  assert.equal(fixture.build,buildId,'Fixture serves a different build');
  assert.equal(fixture.source,await sourceIdentity(),'Client was not built from current source');
  assert.equal(fixture.fixtureVersion,await fixtureIdentity(),'Fixture changed; restart it and capture a compatible baseline');
  const installedPath=execFileSync('adb',['-s',serial,'shell','pm','path',packageName],{encoding:'utf8'}).trim().replace(/^package:/,'');
  assert.ok(installedPath.startsWith('/data/app/')&&installedPath.endsWith('/base.apk'),'Unexpected installed QA package path');
  const installedHash=execFileSync('adb',['-s',serial,'shell','sha256sum',installedPath],{encoding:'utf8'}).split(/\s+/)[0];
  const apkHash=digest(await readFile('android/app/build/outputs/apk/debug/app-debug.apk'));
  assert.equal(installedHash,apkHash,'Installed QA APK differs from the reviewed build');
  if(args.get('--verify-audio')==='true'){
    await mkdir(path.dirname(audioFile),{recursive:true});await writeFile(audioFile,'');
    audioMonitor=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/regression/monitor-audio.ps1'),'-Seconds','600','-OutputPath',audioFile],{windowsHide:true,stdio:'ignore'});
    let ready=false;const deadline=Date.now()+10000;
    while(Date.now()<deadline){if((await readFile(audioFile,'utf8')).includes('"ready"')){ready=true;break;}await new Promise(r=>setTimeout(r,100));}
    assert.ok(ready,'Audio output monitor unavailable');
  }
  const baseline = args.get('--baseline') ? JSON.parse(await readFile(args.get('--baseline'),'utf8')) : null;
  const results=[];
  for (const s of config.scenarios) {
    const level = s.kind==='audio'&&s.verifyAudioSamples?'client-decoded-fixture-tone':{image:'decoded-visible-dom',video:'visible-video-frame-callback',audio:'audio-timeline',element:'visible-dom'}[s.kind];
    const metadata={scenarioId:s.id,budget:s.budget,measurementLevel:level,device:serial,appVersion:buildId,fixtureVersion:fixture.fixtureVersion,cacheMode:s.cacheMode||'warm',runtimeProfile,scenarioVersion:digest(Buffer.concat([methodIdentity,Buffer.from(JSON.stringify(s))]))};
    const runs=[];
    for(let i=0;i<attempts;i++) {
      let run;
      try {
        if(s.prepareUrl){
          assert.equal(new URL(s.prepareUrl).origin,'http://127.0.0.1:3100','Automatic preparation is confined to the synthetic fixture');
          await call('Page.navigate',{url:s.prepareUrl});
          let ready=false;const deadline=Date.now()+15000;
          while(Date.now()<deadline){const r=await call('Runtime.evaluate',{expression:`!!document.querySelector(${JSON.stringify(s.clickSelector)})`,returnByValue:true});if(r.result?.value){ready=true;break;}await new Promise(r=>setTimeout(r,100));}
          assert.ok(ready,'Scenario preparation failed');
          assert.equal(await connection.evaluate(`document.querySelector('meta[name="tms-regression-build"]')?.content`),buildId,'WebView is not showing the served build');
          if(s.cacheMode==='cold')await call('Network.clearBrowserCache');
          if(s.cacheMode==='warm'){
            const warm=await call('Runtime.evaluate',{expression:`(async()=>{const e=document.querySelector(${JSON.stringify(s.clickSelector)});const src=e?.href&&new URL(e.href,location.href).searchParams.get('src');if(!src)return false;const r=await fetch(src,{cache:'reload'});if(!r.ok)return false;await r.arrayBuffer();return true;})()`,awaitPromise:true,returnByValue:true});
            assert.equal(warm.result?.value,true,'Warm media preparation failed');
          }
        }
        const r=await call('Runtime.evaluate',{expression:`(${probe.toString()})(${JSON.stringify(s)})`,awaitPromise:true,returnByValue:true,userGesture:true,timeout:Math.min(25000, (s.timeoutMs || 15000)+2000)});
        run = r.exceptionDetails ? {status:'blocked',reason:'probe-error'} : r.result.value ?? {status:'blocked',reason:'empty-result'};
        if(s.kind==='audio'&&run.status==='ok'&&audioMonitor){
          let tone;const deadline=Date.now()+1500;
          while(Date.now()<deadline){const events=(await readFile(audioFile,'utf8')).trim().split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});tone=events.find(e=>e.status==='tone'&&e.utcMs>=run.startedAtUtcMs&&e.utcMs<=run.startedAtUtcMs+run.ms+1500);if(tone)break;await new Promise(r=>setTimeout(r,50));}
          run={...run,hostToneDiagnostic:tone?'observed-unattributed':'not-observed',audibleOutput:'unverified'};
        }
        if (args.get('--screenshots') === 'true' || s.verifyPixels) {
          const evidenceStarted=Date.now();
          // A playing video advances between the reference sample, the CDP
          // capture and the screencap, so the three would show different frames.
          // Hold the measured frame still (after timing is recorded) so all three
          // prove the same picture; the match threshold is unchanged.
          if(s.verifyPixels&&s.kind==='video'){
            const held=await call('Runtime.evaluate',{expression:`(async()=>{const root=${JSON.stringify(s.shadowHostSelector||'')}?document.querySelector(${JSON.stringify(s.shadowHostSelector||'')})?.shadowRoot:document;const v=[...(root?.querySelectorAll(${JSON.stringify(s.resultSelector)})||[])].find(e=>(e.currentSrc||e.src||'').includes(${JSON.stringify(s.sourceIncludes||'')}));if(!v)return false;v.pause();const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));for(let i=0;i<3;i++)await frame();const t=v.currentTime;await new Promise(r=>setTimeout(r,150));for(let i=0;i<2;i++)await frame();return v.paused&&v.currentTime===t;})()`,awaitPromise:true,returnByValue:true});
            assert.equal(held.result?.value,true,'Could not hold the video frame for pixel evidence');
          }
          const reference=s.verifyPixels?await connection.evaluate(referenceExpression(s.displaySelector||s.resultSelector)):null;
          const foreground=execFileSync('adb',['-s',serial,'shell','dumpsys','activity','activities'],{encoding:'utf8'}).split(/\r?\n/).find(line=>/topResumedActivity|mResumedActivity/.test(line));
          assert.ok(foreground?.includes(packageName+'/'),'Regression app is not foreground');
          // The CDP capture is exactly the WebView viewport, so CSS coordinates
          // map by a pure scale; the display capture proves it reached the screen.
          let viewportCapture=null;
          if(s.verifyPixels){try{viewportCapture=Buffer.from((await call('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false})).data,'base64');}catch{}}
          const capture=execFileSync('adb',['-s',serial,'exec-out','screencap','-p']);
          const viewportAfter=s.verifyPixels?await connection.evaluate(viewportExpression):null;
          await mkdir(evidenceDirectory,{recursive:true});
          const screenshot=path.join(evidenceDirectory,`scenario-${results.length+1}-attempt-${i+1}.png`);
          await writeFile(screenshot,capture);run={...run,screenshot};
          if(viewportCapture){const viewportScreenshot=screenshot.replace(/\.png$/,'-viewport.png');await writeFile(viewportScreenshot,viewportCapture);run={...run,viewportScreenshot};}
          if(s.verifyPixels&&run.status==='ok'){
            const pixels=verifyScreens({reference,viewportCapture,displayCapture:capture,viewportAfter});
            run={...run,screenshotPixels:pixels};
            run={...run,evidenceOverheadMs:Date.now()-evidenceStarted,measurement:'client-ready-with-reference-screen-proof'};
            if(!pixels.verified)run={...run,status:'failed',reason:'display-pixels-mismatch',pixelReason:pixels.reason};
          }
        }
      } catch(error) { run = {status:'blocked',reason:error.message==='Scenario preparation failed'?'preparation-timeout':'cdp-error'}; }
      runs.push(run);
      console.log(JSON.stringify({scenario:s.id,attempt:i+1,status:run.status,ms:run.ms,reason:run.reason,...(run.pixelReason?{pixelReason:run.pixelReason}:{})}));
    }
    const comparison=baseline?.results?.find(x=>x.metadata.scenarioId===s.id);
    const summary=assess(metadata,runs,baseline ? comparison || {} : null);
    results.push({metadata,attempts:runs,summary,...(s.kind==='audio'?{audibleOutput:'unverified'}:{})});
  }
  const report={version:2,runId,source:fixture.source,fixture:fixture.fixtureVersion,results};
  const out=args.get('--output') || 'private/performance-report.json'; await mkdir(path.dirname(out),{recursive:true}); await writeFile(out,JSON.stringify(report,null,2));
  if(args.get('--capture-baseline')) {
    assert.ok(results.every(r=>r.summary.status !== 'blocked' && r.summary.valid === attempts && r.summary.failures === 0), 'Cannot capture incomplete or failing baseline');
    const file=args.get('--capture-baseline'); await mkdir(path.dirname(file),{recursive:true});
    await writeFile(file,JSON.stringify({version:1,results:results.map(r=>({metadata:r.metadata,median:r.summary.median}))},null,2),{flag:'wx'});
  }
  console.log(JSON.stringify({status:results.some(r=>['fail','blocked'].includes(r.summary.status))?'FAIL':results.some(r=>r.summary.status==='warn')?'WARN':'PASS',scenarios:results.length,report:out,screenshotVerification:results.every(r=>r.attempts.every(a=>!config.scenarios.find(s=>s.id===r.metadata.scenarioId).verifyPixels||a.screenshotPixels?.verified))?'reference-grid':'incomplete'}));
  if(results.some(r=>['fail','blocked'].includes(r.summary.status))) process.exitCode=1;
} finally { audioMonitor?.kill();connection.close(); }
