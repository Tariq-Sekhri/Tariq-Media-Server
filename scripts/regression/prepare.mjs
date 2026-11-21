import {attach,openFixturePage} from './cdp.mjs';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const [serial,mode='open']=process.argv.slice(2);
const packageName=process.env.TMS_REGRESSION_PACKAGE||'ca.sekhrit.tms.regression';
if(packageName!=='ca.sekhrit.tms.regression')throw Error('Fixture operations require the isolated regression app');
const c=await attach(serial,packageName);
try {
  if(mode==='open') await openFixturePage(c,'/demo');
  else if(mode==='music')await c.call('Page.navigate',{url:'http://127.0.0.1:3100/?folder=Music'});
  else if(mode==='photos')await c.call('Page.navigate',{url:'http://127.0.0.1:3100/?folder=Family%20Photos%2FBeach%20Trip%202024'});
  else if(mode==='video')await c.call('Page.navigate',{url:'http://127.0.0.1:3100/?folder=Movies%20and%20Shows%2FOrbital%20Drift%2FSeason%201'});
  else {
    if(!await c.evaluate('location.origin === "http://127.0.0.1:3100"'))throw Error('Inspect only the synthetic fixture origin');
    if(mode==='shot'){
      const shot=execFileSync('adb',['-s',serial,'exec-out','screencap','-p']);
      await writeFile('private/regression-client.png',shot);
    } else if(mode==='media') console.log(JSON.stringify(await c.evaluate(`([...document.querySelectorAll('audio,video,.watch-image,.watch-video-canvas')].map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,cls:e.className,src:e.currentSrc||e.src,paused:e.paused,muted:e.muted,volume:e.volume,time:e.currentTime,ready:e.readyState,error:e.error?.code,pointerEvents:getComputedStyle(e).pointerEvents,rect:{x:r.x,y:r.y,w:r.width,h:r.height},hits:[.2,.5,.8].map(t=>document.elementFromPoint(r.x+r.width*t,r.y+r.height*t)?.className)}}))`)));
    else if(mode==='video-state')console.log(JSON.stringify(await c.evaluate(`(()=>{const host=document.querySelector('.watch-video-engine > div'),canvas=document.querySelector('.watch-video-canvas');return {video:[...(host?.shadowRoot?.querySelectorAll('video')||[])].map(v=>({src:v.currentSrc,paused:v.paused,time:v.currentTime,ready:v.readyState,frames:v.getVideoPlaybackQuality?.().totalVideoFrames})),canvas:canvas&&{width:canvas.width,height:canvas.height,style:getComputedStyle(canvas).pointerEvents,parent:canvas.parentElement.className,opacity:getComputedStyle(canvas).opacity}};})()`)));
    else console.log(JSON.stringify(await c.evaluate(`({title:document.title,body:document.body?.innerText.slice(0,2500),links:[...document.querySelectorAll('a')].slice(0,25).map(a=>({text:a.textContent,href:a.getAttribute('href')})),buttons:[...document.querySelectorAll('button')].slice(0,20).map(a=>({text:a.textContent,label:a.getAttribute('aria-label')}))})`)));
  }
}finally{c.close();}
