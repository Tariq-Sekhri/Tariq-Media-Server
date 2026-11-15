import {attach} from './cdp.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const serial=process.argv[2];
const packageName='ca.sekhrit.tms.regression';
let c=await attach(serial,packageName);
const results=[];
const evaluate=expression=>c.evaluate(expression);
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8'}).trim();
async function wait(expression,timeout=7000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,60));}throw Error('Expected client state was not reached');}
async function page(pathname){await c.call('Page.navigate',{url:'http://127.0.0.1:3100'+pathname});await wait(`!!document.querySelector('a.card-label-link, .main-workspace, .watch-page')`);}
async function click(selector){await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>{const r=e.getBoundingClientRect();return !e.disabled&&r.width>0&&r.height>0})`);const r=await c.call('Runtime.evaluate',{expression:`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});if(!e||e.disabled)return false;e.click();return true;})()`,returnByValue:true,userGesture:true});assert.equal(r.result?.value,true,'Expected usable app control');}
async function check(id,description,run){if(process.argv[3]&&process.argv[3]!==id)return;try{await run();results.push({id,description,status:'pass'});}catch(error){results.push({id,description,status:'fail',reason:error.message});}console.log(JSON.stringify(results.at(-1)));}
try{
  await page('/demo');
  await check('R23','Audio-only folder hides zero-match and redundant media filters',async()=>{
    await page('/?folder=Music');await wait(`document.querySelectorAll('a.card-label-link').length===24`);
    const filters=await evaluate(`[...document.querySelectorAll('.tag-strip button')].map(e=>e.textContent.trim())`);
    for(const label of ['Videos','Images','Audio'])assert.ok(!filters.includes(label),`Unexpected ${label} filter`);
  });
  await check('R38','Library and Admin navigation preserve the document',async()=>{
    await page('/');const origin=await evaluate('performance.timeOrigin');
    await click('a.card-label-link[href*="folder=Music"]');await wait(`location.search.includes('folder=Music')&&document.querySelectorAll('a.card-label-link').length===24`);
    assert.equal(await evaluate('performance.timeOrigin'),origin);
    await click('a[href="/admin?section=notifications"]');await wait(`location.pathname==='/admin'`);
    assert.equal(await evaluate('performance.timeOrigin'),origin);
    assert.ok((await evaluate('document.body.innerText')).length>40);
  });
  for(const alongside of [false,true])for(const action of ['tap','all','shuffle']){
    await check(`R03-${alongside}-${action}`,'Audio entry retains browse and creates an advancing player',async()=>{
      await page('/?folder=Music');
      await evaluate(`localStorage.setItem('tms:library-playback',JSON.stringify({music:{alongside:${alongside}}}))`);
      await page('/?folder=Music');await wait(`document.querySelectorAll('a.card-label-link').length===24`);
      const selector=action==='tap'?'a.card-label-link[href*="Afterglow.mp3"]':action==='all'?'button[aria-label="Play all media"]':'button[aria-label="Shuffle media"]';
      if(action==='tap')await click(selector);else{
        const r=await c.call('Runtime.evaluate',{expression:`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(action==='all'?'Play all':'Shuffle')});if(!e)return false;e.click();return true;})()`,returnByValue:true,userGesture:true});assert.equal(r.result?.value,true);
      }
      await wait(`(()=>{const a=document.querySelector('.miniplayer audio');return a&&!a.paused&&!a.error&&a.currentTime>.15})()`);
      assert.equal(await evaluate('location.pathname'),'/');assert.ok((await evaluate('location.search')).includes('folder=Music'));
      const before=await evaluate(`document.querySelector('.miniplayer audio').currentTime`);
      await wait(`document.querySelector('.miniplayer audio')?.currentTime>${before+.15}`);
    });
  }
  await check('R17','Clicking the second image retains its queue index',async()=>{
    await page('/?folder=Family%20Photos%2FBeach%20Trip%202024');await wait(`document.querySelectorAll('a.card-label-link').length===12`);
    await evaluate(`document.querySelectorAll('a.card-label-link')[1].click()`);
    await wait(`location.pathname==='/watch'&&document.querySelector('.watch-image')?.complete`);
    // The image can finish before the queue request does; the position is
    // only meaningful once the queue has loaded, and it must then be 2 of 12.
    await wait(`(()=>{const q=document.querySelector('.watch-queue-trigger')?.getAttribute('aria-label');return !!q&&!q.startsWith('Loading queue')})()`);
    assert.equal(await evaluate(`document.querySelector('.watch-queue-trigger').getAttribute('aria-label')`),'Queue: 2 of 12. View queue.');
    assert.ok((await evaluate('document.body.innerText')).includes('2 of 12'));
  });
  await check('R39','Playback Back returns to the originating folder',async()=>{
    await page('/?folder=Family%20Photos%2FBeach%20Trip%202024');await click('a.card-label-link[href*="IMG_0002"]');
    await wait(`location.pathname==='/watch'&&document.querySelector('.watch-image')?.complete`);
    await click('button[aria-label="Back to library"]');await wait(`location.pathname==='/'&&location.search.includes('Beach')`);
  });
  await check('R40','Audio player leaves mobile navigation reachable',async()=>{
    await page('/?folder=Music');await click('a.card-label-link[href*="Afterglow.mp3"]');await wait(`!!document.querySelector('.miniplayer audio')`);
    const bounds=await evaluate(`(()=>{const p=document.querySelector('.miniplayer').getBoundingClientRect();const nav=document.querySelector('.mobile-nav, .mobile-bottom-nav, nav[aria-label="Main navigation"]');if(!nav)return null;const r=nav.getBoundingClientRect();return {playerBottom:p.bottom,navTop:r.top,navHeight:r.height}})()`);
    assert.ok(bounds&&bounds.navHeight>0,'Mobile navigation must be rendered');assert.ok(bounds.playerBottom<=bounds.navTop+2,'Player overlaps navigation');
  });
  await check('R04-close','Closing playback does not resurrect the previous audio player',async()=>{
    await page('/?folder=Music');await click('a.card-label-link[href*="Afterglow.mp3"]');await wait(`!!document.querySelector('.miniplayer audio')`);
    await click('.miniplayer-expand');await click('button[aria-label="Close miniplayer"]');
    await wait(`!document.querySelector('.miniplayer audio')`);
    await click('a[href="/?section=recent"]');await wait(`location.search.includes('section=recent')`);
    await c.evaluate('history.back()');await wait(`location.search.includes('folder=Music')`);
    await new Promise(r=>setTimeout(r,500));assert.equal(await c.evaluate(`!!document.querySelector('.miniplayer audio')`),false);
  });
  await check('R05','Screen lock hands the real video player to advancing background audio',async()=>{
    await page('/?folder=Movies%20and%20Shows%2FOrbital%20Drift%2FSeason%201');
    await click('a.card-label-link[href*="S01E01"]');
    await wait(`(()=>{const root=document.querySelector('.watch-video-engine > div')?.shadowRoot;return [...(root?.querySelectorAll('video')||[])].some(v=>!v.paused&&v.currentTime>.2)})()`);
    adb('shell','input','keyevent','223');
    try{
      await wait(`(()=>{const a=document.querySelector('body > audio');return a&&!a.paused&&a.currentTime>.3})()`);
      const before=await evaluate(`document.querySelector('body > audio').currentTime`);
      await wait(`document.querySelector('body > audio')?.currentTime>${before+.25}`);
    }finally{adb('shell','input','keyevent','224');adb('shell','wm','dismiss-keyguard');adb('shell','am','start','-n',packageName+'/ca.sekhrit.tms.MainActivity');}
  });
  await check('R09','Natural audio completion advances while the app is hidden',async()=>{
    await page('/?folder=Music');await click('a.card-label-link[href*="Afterglow.mp3"]');
    await wait(`document.querySelector('.miniplayer audio')?.currentTime>.2`);
    const original=await evaluate(`document.querySelector('.miniplayer audio').currentSrc`);
    await evaluate(`document.querySelector('.miniplayer audio').currentTime=11.7`);
    adb('shell','input','keyevent','3');
    try{await wait(`(()=>{const a=document.querySelector('.miniplayer audio');return a&&!a.paused&&a.currentTime>.1&&a.currentSrc!==${JSON.stringify(original)}})()`);}finally{adb('shell','am','start','-n',packageName+'/ca.sekhrit.tms.MainActivity');}
  });
  await check('R10-session','Actual TMS audio publishes the selected track in the native media session',async()=>{
    await page('/?folder=Music');await click('a.card-label-link[href*="Afterglow.mp3"]');await wait(`document.querySelector('.miniplayer audio')?.currentTime>.2`);
    let registered=false;const deadline=Date.now()+5000;
    while(Date.now()<deadline){const sessions=adb('shell','dumpsys','media_session');if(sessions.includes('Afterglow')&&/state=(?:PLAYING\()?3/.test(sessions)){registered=true;break;}await new Promise(r=>setTimeout(r,100));}
    assert.ok(registered,'The selected audio must own an active native media session');
    // Notification PendingIntents are exercised by PlayerNotificationRegressionTest.
  });
  await check('R10','Media-session pause and resume control the actual TMS audio player',async()=>{
    // Real media-button commands are sent through the system MediaSessionService
    // (the same route as headset and notification transport keys). They go to
    // the current media-button session, so first prove it is the TMS session
    // and not another app or a Chromium session.
    const audio=`document.querySelector('.miniplayer audio')`;
    // Read the session that media buttons actually target. Its PlaybackState
    // actions mask is built from the JavaScript handlers registered with the
    // plugin, so a playing session without PAUSE (2), or a paused one without
    // PLAY (4), means the button would be ignored.
    const sessionState=()=>{const s=adb('shell','dumpsys','media_session');const target=s.match(/Media button session is (\S+)/)?.[1]||'';const block=target?s.split(/\r?\n\s*(?=CapgoMediaSession )/).find(b=>b.startsWith(`CapgoMediaSession ${target} `))||'':'';return {target,state:Number(block.match(/state=PlaybackState \{state=\w*\(?(\d+)/)?.[1]??-1),actions:Number(block.match(/\bactions=(\d+)/)?.[1]??0)};};
    async function native(expected){const end=Date.now()+5000;let last;while(Date.now()<end){last=sessionState();if(last.state===expected)break;await new Promise(r=>setTimeout(r,100));}if(last?.state!==expected){const others=(adb('shell','dumpsys','media_session').match(/CapgoMediaSession ca\.sekhrit\.tms\.regression\/CapgoMediaSession\/\d+/g)||[]).length-1;throw Error(`Media-button session ${last?.target} reports state ${last?.state}, not ${expected}`+(others>0?`; ${others} other TMS media session(s) are still registered`:''));}const bit=expected===3?2:4;const settle=Date.now()+3000;while(!(last.actions&bit)&&Date.now()<settle){await new Promise(r=>setTimeout(r,100));last=sessionState();}assert.ok(last.actions&bit,`${expected===3?'Pause':'Play'} handler is not registered with the media session (actions=${last.actions})`);}
    const dispatch=command=>{assert.match(sessionState().target,/^ca\.sekhrit\.tms\.regression\/CapgoMediaSession\//,'Media buttons must target the TMS session');adb('shell','cmd','media_session','dispatch',command);};
    async function advancing(){await wait(`(()=>{const a=${audio};return a&&!a.paused&&!a.error})()`);const t=await evaluate(`${audio}.currentTime`);await wait(`${audio}?.currentTime>${t+.3}`);}
    async function stays(){const t=await evaluate(`${audio}.currentTime`);await new Promise(r=>setTimeout(r,1000));assert.equal(await evaluate(`${audio}.paused`),true,'Pause must stop the actual audio element');assert.ok(Math.abs(await evaluate(`${audio}.currentTime`)-t)<.05,'Paused audio must not advance');}
    await page('/?folder=Music');await click('a.card-label-link[href*="Afterglow.mp3"]');await advancing();await native(3);
    // Foreground: pause, then resume.
    dispatch('pause');await wait(`${audio}?.paused===true`);await native(2);await stays();
    dispatch('play');await advancing();await native(3);
    // Headset and Bluetooth buttons send a toggle that the targeted session
    // resolves from its own state.
    dispatch('play-pause');await wait(`${audio}?.paused===true`);await native(2);await stays();
    dispatch('play-pause');await advancing();await native(3);
    // Hidden and idle while paused, then resume without reopening the app.
    // Rewind first so the track cannot end and change items mid-check.
    await evaluate(`${audio}.currentTime=1`);dispatch('pause');await wait(`${audio}?.paused===true`);await native(2);
    adb('shell','input','keyevent','3');
    try{
      await new Promise(r=>setTimeout(r,20000));
      assert.equal(await evaluate(`${audio}.paused`),true,'Audio resumed by itself while hidden');
      dispatch('play');await advancing();await native(3);
      assert.doesNotMatch(adb('shell','dumpsys','activity','activities').match(/topResumedActivity=.*/)?.[0]||'',/ca\.sekhrit\.tms\.regression\//,'Play must not need the app reopened');
      dispatch('pause');await wait(`${audio}?.paused===true`);await native(2);await stays();
    }finally{adb('shell','am','start','-n',packageName+'/ca.sekhrit.tms.MainActivity');}
  });
  await check('R16','A real renderer crash recovers without terminating the app',async()=>{
    await page('/?folder=Music');
    try{await c.call('Page.crash');}catch{}
    c.close();await new Promise(r=>setTimeout(r,1500));c=await attach(serial,packageName);
    await wait(`location.pathname==='/'&&location.search.includes('folder=Music')`,10000);
    assert.match(adb('shell','pidof','-s',packageName),/^\d+$/);
  });
}finally{
  await mkdir('private',{recursive:true});await writeFile('private/regression-client-journeys.json',JSON.stringify({version:1,packageName,results},null,2));c.close();
}
if(results.some(r=>r.status!=='pass'))process.exitCode=1;
