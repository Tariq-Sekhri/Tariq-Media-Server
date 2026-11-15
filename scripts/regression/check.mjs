import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const serial=args.get('--serial');assert.match(serial||'',/^emulator-\d+$/,'Supply --serial for the dedicated emulator');
const root=path.join('private','regression-runs',String(Date.now()));await mkdir(root,{recursive:true});
const results=[];let fixture;let fixtureLog;let ownsReverse=false;
const adb=(...a)=>execFileSync('adb',['-s',serial,...a],{encoding:'utf8'}).trim();
async function command(name,exe,argv){const file=path.join(root,name+'.log'),fd=openSync(file,'w');const code=await new Promise((resolve,reject)=>{const child=spawn(exe,argv,{stdio:['ignore',fd,fd],windowsHide:true});child.once('error',reject);child.once('exit',resolve);}).finally(()=>closeSync(fd));if(code!==0)throw Error(`${name} exited ${code}; see ${file}`);return {file,text:await readFile(file,'utf8')};}
async function check(name,run){console.log('Running '+name);try{const detail=await run();const {text:log,...report}=detail||{};results.push({name,status:'pass',...report});}catch(error){results.push({name,status:'fail',reason:error.message});}console.log(JSON.stringify(results.at(-1)));return results.at(-1).status==='pass';}
const node=(name,file,extra=[])=>command(name,process.execPath,[file,...extra]);
// Each launched stage starts from a fresh QA process, not whatever screen or
// WebView the previous stage left behind.
async function launch(){adb('shell','am','force-stop','ca.sekhrit.tms.regression');adb('shell','am','start','-W','-f','0x10008000','-n','ca.sekhrit.tms.regression/ca.sekhrit.tms.TmsConnectionActivity');await node('fixture-sign-in','scripts/regression/prepare.mjs',[serial,'open']);}
try {
  await check('node-contracts',async()=>command('node-contracts',process.execPath,['--test',...(await readdir('tests')).filter(f=>f.endsWith('.test.cjs')).map(f=>'tests/'+f)]));
  await check('rust-contracts',async()=>command('rust-contracts','cargo',['test','--manifest-path','backend/Cargo.toml']));
  assert.ok(await check('client-build',()=>node('client-build','scripts/regression/build.mjs')),'Client build blocked emulator checks');
  assert.ok(await check('media-fixtures',()=>node('media-fixtures','scripts/regression/generate-media.mjs')),'Media generation blocked emulator checks');
  assert.ok(await check('copy-assets',()=>command('copy-assets','cmd.exe',['/d','/c','npx.cmd','cap','copy','android'])),'Asset copy failed');
  assert.ok(await check('android-build',()=>node('android-build','scripts/regression/build-android.mjs')),'Android build failed');
  const meta=JSON.parse(await readFile('android/app/build/outputs/apk/debug/output-metadata.json','utf8'));
  assert.equal(meta.applicationId,'ca.sekhrit.tms.regression','Refusing to install a normal app APK');
  adb('install','-r','android/app/build/outputs/apk/debug/app-debug.apk');adb('install','-r','android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
  // Own only the process started here. An occupied fixture port fails setup;
  // never stop an unknown listener to make the run proceed.
  fixtureLog=openSync(path.join(root,'fixture.log'),'w');fixture=spawn(process.execPath,['--experimental-strip-types','scripts/regression/fixture-server.mjs'],{stdio:['ignore',fixtureLog,fixtureLog],windowsHide:true});
  let ready=false;const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(fixture.exitCode!==null)break;try{const r=await fetch('http://127.0.0.1:3100/regression-ready',{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  await new Promise(r=>setTimeout(r,100));assert.ok(ready&&fixture.exitCode===null,'Fixture server did not start; check for an occupied port');
  const reverse=adb('reverse','--list').split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]==='tcp:3100');
  if(reverse)assert.equal(reverse[2],'tcp:3100','Fixture port is already mapped elsewhere');
  else {adb('reverse','tcp:3100','tcp:3100');ownsReverse=true;}
  await check('android-integration',async()=>{const r=await command('android-integration','adb',['-s',serial,'shell','am','instrument','-w','-r','-e','class','ca.sekhrit.tms.NativeLifecycleRegressionTest,ca.sekhrit.tms.NotificationResumeTest,ca.sekhrit.tms.OfflineContentTest,ca.sekhrit.tms.PlayerNotificationRegressionTest','ca.sekhrit.tms.regression.test/androidx.test.runner.AndroidJUnitRunner']);assert.ok(/OK \(9 tests\)/.test(r.text)&&!/FAILURES!!!|Process crashed|INSTRUMENTATION_FAILED/.test(r.text),'Android test assertions failed');return {file:r.file};});
  await launch();await check('client-journeys',()=>node('client-journeys','scripts/regression/journeys.mjs',[serial]));
  await check('offline-lifecycle',()=>node('offline-lifecycle','scripts/regression/offline-journey.mjs',[serial]));
  await launch();
  await check('client-performance',()=>node('client-performance','scripts/regression/run.mjs',['--serial',serial,'--config','scripts/regression/scenarios.json','--screenshots','true','--output',path.join(root,'performance.json'),...(args.get('--baseline')?['--baseline',args.get('--baseline')]:['--capture-baseline',path.join(root,'baseline.json')])]));
}catch(error){results.push({name:'setup',status:'fail',reason:error.message});}
finally {
  fixture?.kill();if(fixtureLog!==undefined)closeSync(fixtureLog);
  if(ownsReverse)try{adb('reverse','--remove','tcp:3100');}catch{}
  const report={results,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status!=='pass').length};
  await writeFile(path.join(root,'summary.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failed:report.failed,report:path.join(root,'summary.json')}));if(report.failed)process.exitCode=1;
}
