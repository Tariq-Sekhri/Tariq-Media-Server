import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
export async function attach(serial,packageName='ca.sekhrit.tms.regression') {
  assert.ok(serial, 'Explicit emulator serial required');
  const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8'}).trim();
  let pid='';
  const launchDeadline=Date.now()+10000;
  while(!pid&&Date.now()<launchDeadline){try{pid=adb('shell','pidof','-s',packageName);}catch{}if(!pid)await new Promise(r=>setTimeout(r,250));}
  assert.match(pid,/^\d+$/,'TMS must be running');
  const port=adb('forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`);
  let socket;
  const keepAlive=setInterval(()=>{},1000);
  try {
    // A relaunch over a running task briefly exposes the outgoing and the new
    // activity's WebViews together; wait for that handover to finish.
    const activeTargets=targets=>{const attached=targets.filter(t=>{try{return JSON.parse(t.description).attached===true;}catch{return false;}});return attached.length?attached:targets;};
    let active=[];
    const targetDeadline=Date.now()+10000;
    while(active.length!==1&&Date.now()<targetDeadline){try{active=activeTargets(await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json());}catch{}if(active.length!==1)await new Promise(r=>setTimeout(r,250));}
    assert.equal(active.length,1,'Expected exactly one attached app WebView');
    socket=new WebSocket(active[0].webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WebView connection timeout')),10000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('WebView connection error'));},{once:true});socket.addEventListener('close',()=>{clearTimeout(timer);reject(Error('WebView closed during connection'));},{once:true});});
    let sequence=0;const pending=new Map();
    socket.addEventListener('message',e=>{const m=JSON.parse(e.data);const cb=pending.get(m.id);if(cb){pending.delete(m.id);cb(m);}});
    socket.addEventListener('close',()=>{for(const cb of pending.values())cb({error:{message:'WebView disconnected'}});pending.clear();});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('WebView command timeout'));},30000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(Error(m.error.message)):resolve(m.result);});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
    return {call,evaluate,close(){socket.close();adb('forward','--remove',`tcp:${port}`);}};
  }catch(error){socket?.close();adb('forward','--remove',`tcp:${port}`);throw error;}finally{clearInterval(keepAlive);}
}
