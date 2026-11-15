// Destructive operations are confined to the separate QA package and its
// explicitly marked fixture folder on an explicitly selected emulator.
import {attach} from './cdp.mjs';
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const serial=process.argv[2],pkg='ca.sekhrit.tms.regression',folder='/sdcard/Download/TMSRegression';
assert.match(serial||'',/^emulator-\d+$/,'Offline lifecycle tests require an explicit emulator');
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8'}).trim();
let c,created=false;const results=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(){c?.close();c=await attach(serial,pkg);}
async function wait(expression,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await c.evaluate(expression))return;}catch{}await pause(100);}throw Error('Expected offline client state not reached');}
async function page(pathname){await c.call('Page.navigate',{url:'http://127.0.0.1:3100'+pathname});await wait('!!document.querySelector(".main-workspace, .workspace, .watch-page")');}
async function clickText(text){const r=await c.call('Runtime.evaluate',{expression:`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().height>0);if(!e)return false;e.click();return true})()`,returnByValue:true,userGesture:true});assert.equal(r.result?.value,true,'Missing app action '+text);}
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&apos;',"'");
function tree(){const xml=adb('exec-out','uiautomator','dump','/dev/tty');return [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])])));}
function tap(nodes,pattern){const node=nodes.find(n=>n.enabled!=='false'&&(pattern.test(n.text||'')||pattern.test(n['content-desc']||'')));if(!node)return false;const b=node.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);if(!b)return false;adb('shell','input','tap',String(Math.round((+b[1]+ +b[3])/2)),String(Math.round((+b[2]+ +b[4])/2)));return true;}
async function openDownloadSettings(){
  if(!await c.evaluate(`!!document.querySelector('button[aria-label="Close settings"]')`)){
    await c.evaluate(`document.querySelector('button[aria-label="Account menu"]').click()`);
    await clickText('Settings');
  }
  await clickText('Downloads');
}
async function chooseFolder(){
  await openDownloadSettings();
  await clickText('Choose folder');
  let chosen=false;
  for(let i=0;i<8&&!chosen;i++){
    const nodes=tree();
    if(nodes.some(n=>n.text==='Open from')){adb('shell','input','keyevent','4');continue;}
    if(!nodes.some(n=>n.text==='TMSRegression')&&tap(nodes,/^Download$/)){await pause(200);continue;}
    if(nodes.some(n=>n.text==='TMSRegression')&&nodes.some(n=>/use this folder/i.test(n.text||''))){
      // The folder may be a child row or the current breadcrumb.
      const row=nodes.find(n=>n.text==='TMSRegression'&&/title/.test(n['resource-id']||''));
      if(row&&nodes.filter(n=>n.text==='TMSRegression').length===1&&nodes.some(n=>n['resource-id']?.includes('dir_list')))tap([row],/^TMSRegression$/);
      else tap(nodes,/^TMSRegression$/);
      await pause(200);
      const updated=tree();if(tap(updated,/^use this folder$/i)){chosen=true;break;}
    }
    if(tap(nodes,/^TMSRegression$/)){await pause(200);const updated=tree();if(tap(updated,/^use this folder$/i)){chosen=true;break;}}
    if(tap(nodes,/^Show roots$|^Show navigation drawer$/i)){await pause(150);const roots=tree();if(!tap(roots,/^Downloads$/i)){const model=adb('shell','getprop','ro.product.model');tap(roots,new RegExp('^'+model.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'));}}
    await pause(250);
  }
  assert.ok(chosen,'Could not select the owned offline fixture folder');
  await pause(200);tap(tree(),/^Allow$/i);
  await wait(`document.body.innerText.includes('TMSRegression')`);
  await c.evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`);
}
async function nativeList(){return c.evaluate(`Capacitor.nativePromise('TmsOffline','list',{ownerId:1})`);}
async function record(id,description,run){await run();results.push({id,description,status:'pass'});console.log(JSON.stringify(results.at(-1)));}
async function control(offline){const r=await fetch('http://127.0.0.1:3100/regression/control',{method:'POST',body:JSON.stringify({offline})});assert.ok(r.ok);}
try {
  // Start from a known device state instead of whatever earlier stages or
  // runs left: an empty owned fixture folder and a QA app with no data, no
  // saved folder and no URI grants.
  let exists=false;try{adb('shell','test','-d',folder);exists=true;}catch{}
  if(exists){assert.equal(adb('shell','cat',folder+'/.regression-owned'),'regression-v1','Refusing an unowned folder');adb('shell','rm','-r',folder);}
  adb('shell','mkdir','-p',folder);adb('shell',"printf regression-v1 > /sdcard/Download/TMSRegression/.regression-owned");created=true;
  adb('shell','am','force-stop',pkg);assert.equal(adb('shell','pm','clear',pkg),'Success');
  // A backup restore returns the saved folder preference without its grant.
  const restoredPrefs=Buffer.from(`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="tree_uri">content://com.android.externalstorage.documents/tree/primary%3ADownload%2FTMSRegression</string>
    <string name="tree_name">TMSRegression</string>
</map>
`).toString('base64');
  adb('shell',`run-as ${pkg} sh -c 'mkdir -p shared_prefs && echo ${restoredPrefs} | base64 -d > shared_prefs/tms_offline.xml'`);
  adb('shell','am','start','-f','0x10008000','-n',pkg+'/ca.sekhrit.tms.TmsConnectionActivity');await connect();
  await page('/demo');await page('/?section=offline');
  await record('R29-restored','A restored folder preference without its grant asks for a folder again',async()=>{
    const location=await c.evaluate(`Capacitor.nativePromise('TmsOffline','getLocation',{})`);
    assert.deepEqual(location,{configured:false,name:''},'An ungranted folder must not count as chosen');
    assert.equal((await nativeList()).locationName,'','An ungranted folder must not be named as the download location');
    await openDownloadSettings();
    await wait(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Choose folder'&&e.getBoundingClientRect().height>0)`);
    assert.equal(await c.evaluate(`document.body.innerText.includes('TMSRegression')`),false,'The ungranted folder name must not be shown');
  });
  await chooseFolder();
  await record('R29-setup','Download a synthetic library through the actual app',async()=>{
    await page('/');await wait(`!!document.querySelector('button[aria-label="More actions for Music"]')`);
    await c.evaluate(`document.querySelector('button[aria-label="More actions for Music"]').click()`);
    await clickText('Save offline');
    await wait(`Capacitor.nativePromise('TmsOffline','list',{ownerId:1}).then(r=>(r.bundles||[]).some(b=>b.status==='ready'&&b.files.length>0))`,30000);
    const list=await nativeList();assert.ok(list.bundles.some(b=>b.path==='Music'&&b.status==='ready'));
  });
  await record('R30','Reinstall and reselect restores files and folder catalog',async()=>{
    c.close();c=null;adb('shell','am','force-stop',pkg);adb('uninstall',pkg);
    adb('install','android/app/build/outputs/apk/debug/app-debug.apk');
    adb('shell','am','start','-n',pkg+'/ca.sekhrit.tms.TmsConnectionActivity');await connect();
    await page('/demo');await page('/?section=offline');await chooseFolder();
    await wait(`Capacitor.nativePromise('TmsOffline','list',{ownerId:1}).then(r=>(r.bundles||[]).some(b=>b.path==='Music'&&b.status==='ready'))`);
  });
  await record('R02-cold','Recovered audio plays after a cold launch with server unavailable',async()=>{
    await control(true);c.close();c=null;adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',pkg+'/ca.sekhrit.tms.TmsConnectionActivity');await connect();
    await wait(`document.body.innerText.includes('Music')`,20000);
    await c.evaluate(`(()=>{const e=[...document.querySelectorAll('a.card-label-link,button.media-list-main')].find(e=>e.textContent.includes('Music'));if(!e)throw Error('Recovered folder missing');e.click()})()`);
    await wait(`!![...document.querySelectorAll('a.card-label-link,button.media-list-main')].find(e=>e.textContent.includes('Afterglow'))`);
    await c.evaluate(`(()=>{const e=[...document.querySelectorAll('a.card-label-link,button.media-list-main')].find(e=>e.textContent.includes('Afterglow'));e.click()})()`);
    await wait(`(()=>{const a=document.querySelector('.miniplayer audio');return a&&!a.paused&&a.currentTime>.2&&!a.currentSrc.includes('/media/')})()`);
    await control(false);
  });
  await record('R28','An unavailable offline folder preserves its grant and catalog without a crash',async()=>{
    const before=await nativeList();
    const saved=before.bundles.find(b=>b.path==='Music'&&b.status==='ready');
    assert.ok(saved,'Expected the recovered download before removing its folder');
    assert.equal(adb('shell','cat',folder+'/.regression-owned'),'regression-v1');
    adb('shell','rm','-r',folder);created=false;
    await control(false);await page('/?section=offline');
    const location=await c.evaluate(`Capacitor.nativePromise('TmsOffline','getLocation',{})`);
    assert.equal(location.configured,true,'The persisted grant should survive a temporarily unavailable folder');
    const list=await nativeList();
    assert.deepEqual(list.bundles.find(b=>b.id===saved.id),saved,'The catalog must remain recoverable');
    assert.match(adb('shell','pidof','-s',pkg),/^\d+$/);
    let recreated=false;try{adb('shell','test','-d',folder);recreated=true;}catch{}assert.equal(recreated,false);
  });
}catch(error){results.push({status:'fail',reason:error.message});console.error(error.message);process.exitCode=1;}
finally{try{await control(false);}catch{}c?.close();await mkdir('private',{recursive:true});await writeFile('private/regression-offline-journey.json',JSON.stringify({results,fixtureFolderRetained:created},null,2));}
