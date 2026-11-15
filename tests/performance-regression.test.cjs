'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {assess} = require('../scripts/regression/budgets.cjs');
const {probe} = require('../scripts/regression/probe.cjs');
const {percentile,budgets}=require('../scripts/regression/budgets.cjs');
const {decodePng,checkRegion,checkReference,captureMapping,objectContentRect,referenceSamples,collectReference,referenceExpression,verifyScreens}=require('../scripts/regression/pixels.cjs');
const {deflateSync}=require('node:zlib');
const meta = {scenarioId:'example',budget:'direct-video',measurementLevel:'visible-video-frame-callback',device:'test-device',appVersion:'test-version',fixtureVersion:'v1',cacheMode:'warm',runtimeProfile:'device-profile',scenarioVersion:'method-v1'};
test('absolute failures apply per attempt and percentiles use valid measurements',()=>{
  const r=assess(meta,[{status:'ok',ms:100},{status:'ok',ms:3000},{status:'failed'}]);
  assert.equal(r.status,'fail'); assert.equal(r.failures,2); assert.equal(r.median,1550); assert.equal(r.p95,3000); assert.equal(r.worst,3000);
});
test('relative median thresholds and incompatible baselines',()=>{
  const base={metadata:meta,median:1000};
  assert.equal(assess(meta,[{status:'ok',ms:1400}],base).status,'warn');
  assert.equal(assess(meta,[{status:'ok',ms:1800}],base).status,'fail');
  assert.equal(assess(meta,[{status:'ok',ms:100}],{...base,metadata:{...meta,device:'other'}}).status,'blocked');
  assert.notEqual(assess(meta,[{status:'blocked'}]).status,'pass');
  assert.equal(assess({...meta,appVersion:'new-build'},[{status:'ok',ms:1500}],base).status,'fail', 'compare across builds and apply percentage AND minimum increase');
  assert.equal(assess(meta,[{status:'ok',ms:1250}],base).status,'warn');
});
function environment(overrides={}) {
  let now=0; const target={disabled:false,getClientRects:()=>[{}],click(){}};
  const el={currentSrc:'https://example.invalid/expected',complete:true,naturalWidth:20,naturalHeight:20,decode:async()=>{},getBoundingClientRect:()=>({left:0,top:0,right:20,bottom:20,width:20,height:20}),contains:()=>false,...overrides};
  global.performance={now:()=>now+=10}; global.innerWidth=100; global.innerHeight=100;
  global.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});
  global.document={querySelector:s=>s==='#click'?target:el,elementFromPoint:()=>el};
  return el;
}
const scenario={clickSelector:'#click',resultSelector:'#result',kind:'image',sourceIncludes:'expected',timeoutMs:60};
test('image probe rejects wrong source, hidden, stale and broken images',async()=>{
  environment({currentSrc:'https://example.invalid/wrong'}); assert.equal((await probe(scenario)).status,'failed');
  environment({naturalWidth:0}); assert.equal((await probe(scenario)).status,'failed');
  environment(); global.document.elementFromPoint=()=>({}); assert.equal((await probe(scenario)).status,'failed');
  environment(); assert.equal((await probe({...scenario,requireSourceChange:true})).status,'failed');
  environment(); assert.equal((await probe(scenario)).status,'ok');
});
test('video probe rejects stalled frame callbacks',async()=>{
  environment({paused:false,error:null,readyState:4,requestVideoFrameCallback:()=>{}});
  // A single non-progressing callback must never establish video playback.
  assert.equal((await probe({...scenario,kind:'video'})).status,'failed');
});

test('percentiles, invalid samples and every budget boundary remain strict',()=>{
  assert.equal(percentile([9,1,3,7],.5),5);
  assert.equal(percentile([9,1,3,7],.95),9);
  assert.equal(percentile([],.5),null);
  for(const [budget,[warning,failure]] of Object.entries(budgets)){
    assert.equal(assess({...meta,budget},[{status:'ok',ms:warning}]).status,'warn',budget);
    assert.equal(assess({...meta,budget},[{status:'ok',ms:failure}]).status,'fail',budget);
  }
  for(const ms of [NaN,Infinity,-1])assert.equal(assess(meta,[{status:'ok',ms}]).status,'fail');
});

test('comparison cannot mix cold/warm runs or fixtures, but can compare different builds',()=>{
  const base={metadata:meta,median:100};
  assert.equal(assess({...meta,fixtureVersion:'v2'},[{status:'ok',ms:100}],base).status,'blocked');
  assert.equal(assess({...meta,cacheMode:'cold'},[{status:'ok',ms:100}],base).status,'blocked');
  assert.equal(assess({...meta,appVersion:'next'},[{status:'ok',ms:120}],base).status,'pass');
  assert.equal(assess(meta,[{status:'ok',ms:200}],base).status,'pass','minimum absolute increase prevents tiny timing noise');
});

function png(color){
  const chunk=(kind,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(kind,4);data.copy(b,8);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(4,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(4*13);for(let y=0;y<4;y++)for(let x=0;x<4;x++)Buffer.from(color).copy(rows,y*13+1+x*3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
test('screen evidence rejects black, wrong expected pixels, invalid PNG and offscreen regions',()=>{
  const area={x:0,y:0,width:.9,height:.9};
  assert.equal(checkRegion(png([0,0,0]),area).verified,false);
  assert.equal(checkRegion(png([40,190,140]),area,[190,40,140]).verified,false);
  assert.equal(checkRegion(png([40,190,140]),area,[40,190,140]).verified,true);
  assert.equal(checkRegion(png([40,190,140]),{...area,x:2}).verified,false);
  assert.throws(()=>decodePng(Buffer.from('not PNG')));
});

test('image decode failures and CSS-hidden content never count as visible',async()=>{
  environment({decode:async()=>{throw Error('decode');}});assert.equal((await probe(scenario)).status,'failed');
  environment();global.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'0'});
  assert.equal((await probe(scenario)).status,'failed');
});

test('reference proof rejects unrelated colorful overlays and missing references',()=>{
  const viewport={width:4,height:4,dpr:1,scale:1,offsetLeft:0,offsetTop:0};
  const points=Array.from({length:25},(_,i)=>({x:(i%5+.5)*.8,y:(Math.floor(i/5)+.5)*.8,rgb:[50+i*5,200-i*4,30+i*7]}));
  assert.equal(checkReference(png([220,20,150]),{viewport,points}).verified,false);
  assert.equal(checkReference(png([220,20,150]),{viewport,points:[]}).verified,false);
  assert.equal(checkReference(png([0,0,0]),{viewport,points}).verified,false);
  assert.equal(checkReference(png([0,0,0]),{error:'missing-element'}).reason,'missing-element');
  assert.equal(assess({...meta,runtimeProfile:'changed'},[{status:'ok',ms:10}],{metadata:meta,median:10}).status,'blocked');
  assert.equal(assess({...meta,scenarioVersion:'changed'},[{status:'ok',ms:10}],{metadata:meta,median:10}).status,'blocked');
});

// Synthetic screens.
function image(width,height,colorAt){
  const chunk=(kind,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(kind,4);data.copy(b,8);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const stride=width*3+1,rows=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)Buffer.from(colorAt(x,y)).copy(rows,y*stride+1+x*3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
// A colourful, position-dependent source picture, indexed by fraction (u,v).
const source=(u,v)=>[40+Math.floor(u*4)*50,40+Math.floor(v*4)*50,200-Math.floor(u*4)*30];
const fullViewport={width:100,height:80,dpr:1,scale:1,offsetLeft:0,offsetTop:0};
// Element covering the whole viewport, showing the source with object-fit: fill.
function viewportReference(viewport=fullViewport){
  const box={x:0,y:0,width:viewport.width,height:viewport.height};
  return {viewport,points:referenceSamples(box,box,viewport).map(p=>({x:p.x,y:p.y,rgb:source(p.u,p.v)}))};
}

test('display capture with a top inset fails clearly instead of sampling shifted pixels',()=>{
  const reference=viewportReference();
  // 100x100 display: 20px status bar, then the 100x80 WebView.
  const display=image(100,100,(x,y)=>y<20?[10,10,10]:source(x/100,(y-20)/80));
  const result=checkReference(display,reference,'display');
  assert.equal(result.verified,false);
  assert.equal(result.reason,'display-mapping-unavailable');
  assert.deepEqual(captureMapping({width:100,height:100},fullViewport,'display'),{error:'display-mapping-unavailable'});
  // The same pixels as an exact viewport capture verify.
  const viewportShot=image(100,80,(x,y)=>source(x/100,y/80));
  assert.equal(checkReference(viewportShot,reference,'viewport').verified,true);
  // An edge-to-edge WebView that fills the display maps directly.
  assert.equal(checkReference(viewportShot,reference,'display').verified,true);
});

test('captures map CSS pixels through devicePixelRatio and reject zoom or wrong sizes',()=>{
  const viewport={...fullViewport,width:50,height:40,dpr:2};
  const reference=viewportReference(viewport);
  const shot=image(100,80,(x,y)=>source(x/100,y/80));
  assert.equal(checkReference(shot,reference,'viewport').verified,true);
  assert.equal(checkReference(shot,reference,'display').verified,true);
  assert.equal(checkReference(image(100,90,(x,y)=>source(x/100,y/90)),reference,'viewport').reason,'viewport-capture-size-mismatch');
  assert.equal(checkReference(shot,{...reference,viewport:{...viewport,scale:1.5}},'viewport').reason,'zoomed-viewport');
  assert.equal(checkReference(shot,{...reference,viewport:undefined},'viewport').reason,'missing-viewport');
});

test('screen verification needs both proofs and a stable viewport',()=>{
  const reference=viewportReference();
  const good=image(100,80,(x,y)=>source(x/100,y/80));
  const inset=image(100,100,(x,y)=>y<20?[10,10,10]:source(x/100,(y-20)/80));
  assert.equal(verifyScreens({reference,viewportCapture:good,displayCapture:good,viewportAfter:fullViewport}).verified,true);
  assert.equal(verifyScreens({reference,viewportCapture:good,displayCapture:inset,viewportAfter:fullViewport}).reason,'display:display-mapping-unavailable');
  assert.equal(verifyScreens({reference,viewportCapture:null,displayCapture:good,viewportAfter:fullViewport}).reason,'viewport:viewport-capture-unavailable');
  assert.equal(verifyScreens({reference,viewportCapture:good,displayCapture:good,viewportAfter:{...fullViewport,height:79}}).reason,'viewport-changed');
});

test('object-fit and object-position resolve the painted content box',()=>{
  const box={x:10,y:0,width:100,height:100},wide={width:200,height:100},tall={width:50,height:100};
  assert.deepEqual(objectContentRect(box,wide,'contain','50% 50%'),{x:10,y:25,width:100,height:50});
  assert.deepEqual(objectContentRect(box,wide,'cover','50% 50%'),{x:-40,y:0,width:200,height:100});
  assert.deepEqual(objectContentRect(box,wide,'fill','50% 50%'),box);
  assert.deepEqual(objectContentRect(box,tall,'contain','0% 0%'),{x:10,y:0,width:50,height:100});
  assert.deepEqual(objectContentRect(box,tall,'contain','right top'),{x:60,y:0,width:50,height:100});
  assert.deepEqual(objectContentRect(box,wide,'contain','left 0px bottom 5px'),{x:10,y:45,width:100,height:50});
  assert.deepEqual(objectContentRect(box,{width:20,height:10},'scale-down','50% 50%'),{x:50,y:45,width:20,height:10});
  assert.throws(()=>objectContentRect(box,wide,'contain','calc(10% + 2px) 50%'),/unsupported-object-position/);
  assert.throws(()=>objectContentRect(box,{width:0,height:0},'contain'),/unknown-natural-size/);
  // Cover overflows the box: samples stay inside the visible, clipped part.
  const cover=referenceSamples(box,objectContentRect(box,wide,'cover','50% 50%'),{width:400,height:400});
  assert.ok(cover.length&&cover.every(p=>p.x>10&&p.x<110&&p.u>.25&&p.u<.75));
});

test('letterboxed (object-fit: contain) images sample only the painted picture',()=>{
  // 100x100 element showing a 2:1 picture: 25px black bars above and below.
  const viewport={width:100,height:100,dpr:1,scale:1,offsetLeft:0,offsetTop:0};
  const box={x:0,y:0,width:100,height:100};
  const screen=image(100,100,(x,y)=>y<25||y>=75?[0,0,0]:source(x/100,(y-25)/50));
  const drawn=objectContentRect(box,{width:200,height:100},'contain','50% 50%');
  const contained=referenceSamples(box,drawn,viewport).map(p=>({x:p.x,y:p.y,rgb:source(p.u,p.v)}));
  assert.ok(contained.every(p=>p.y>25&&p.y<75));
  assert.equal(checkReference(screen,{viewport,points:contained},'viewport').verified,true);
  // The old mapping stretched the source across the whole element box.
  const stretched=referenceSamples(box,box,viewport).map(p=>({x:p.x,y:p.y,rgb:source(p.u,p.v)}));
  assert.equal(checkReference(screen,{viewport,points:stretched},'viewport').verified,false);
});

test('in-page reference collector honours padding, contain and the source pixels',()=>{
  const saved={document:global.document,getComputedStyle:global.getComputedStyle,innerWidth:global.innerWidth,innerHeight:global.innerHeight,devicePixelRatio:global.devicePixelRatio,window:global.window};
  try{
    const img={tagName:'IMG',complete:true,naturalWidth:200,naturalHeight:100,getBoundingClientRect:()=>({left:0,top:10,width:120,height:120})};
    const canvas={getContext:()=>({drawImage(){},getImageData:(x,y)=>({data:[...source(x/canvas.width,y/canvas.height),255]})})};
    global.document={querySelector:()=>img,createElement:()=>canvas};
    global.window={visualViewport:{scale:1,offsetLeft:0,offsetTop:0}};
    global.innerWidth=120;global.innerHeight=200;global.devicePixelRatio=2;
    global.getComputedStyle=()=>({objectFit:'contain',objectPosition:'50% 50%',paddingLeft:'10px',paddingRight:'10px',paddingTop:'10px',paddingBottom:'10px',borderLeftWidth:'0px',borderRightWidth:'0px',borderTopWidth:'0px',borderBottomWidth:'0px'});
    const r=collectReference('img',objectContentRect,referenceSamples);
    assert.deepEqual(r.content,{x:10,y:45,width:100,height:50});
    assert.equal(r.points.length,81);
    assert.ok(r.points.every(p=>p.x>10&&p.x<110&&p.y>45&&p.y<95));
    const first=r.points[0];
    assert.deepEqual(first.rgb,source(Math.floor((first.x-10)/100*canvas.width)/canvas.width,Math.floor((first.y-45)/50*canvas.height)/canvas.height));
    assert.deepEqual(r.viewport,{width:120,height:200,dpr:2,scale:1,offsetLeft:0,offsetTop:0});
    global.document={querySelector:()=>null};
    assert.equal(collectReference('img',objectContentRect,referenceSamples).error,'missing-element');
    // The serialized expression is valid standalone JavaScript.
    assert.doesNotThrow(()=>new Function('return '+referenceExpression('img.watch-image')));
  }finally{Object.assign(global,saved);}
});

test('build identity covers the service worker and every built asset',async()=>{
  const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
  const {sourceIdentity,buildIdentity,sourceFiles,listFiles}=await import('../scripts/regression/identity.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tms-identity-'));
  try{
    const write=(f,body)=>{fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),body);};
    for(const f of sourceFiles)write(f,f);
    write('app/page.tsx','page');write('patches/x.patch','patch');
    write('public/index.html','<html>');write('public/service-worker.js','v1');write('public/logo.svg','<svg/>');
    const before=await sourceIdentity(root);
    write('public/service-worker.js','v2');
    const afterWorker=await sourceIdentity(root);
    assert.notEqual(afterWorker,before,'service worker source changes identity');
    write('public/logo.svg','<svg>changed</svg>');
    assert.notEqual(await sourceIdentity(root),afterWorker,'static public assets change identity');
    write('package-lock.json','other');
    const lock=await sourceIdentity(root);
    write('app/asset.woff2','font');
    assert.notEqual(await sourceIdentity(root),lock,'non-code app inputs change identity');

    const dist=path.join(root,'dist');
    const put=(f,body)=>{fs.mkdirSync(path.dirname(path.join(dist,f)),{recursive:true});fs.writeFileSync(path.join(dist,f),body);};
    put('index.html','<html>');put('service-worker.js','tms-react-shell-a');put('assets/app-1.js','one');put('app-shell-assets/b.css','b');
    const built=await buildIdentity(dist);
    assert.equal(await buildIdentity(dist),built,'deterministic');
    put('assets/app-1.js','stale');
    const asset=await buildIdentity(dist);
    assert.notEqual(asset,built,'modified asset changes identity');
    put('service-worker.js','tms-react-shell-b');
    const worker=await buildIdentity(dist);
    assert.notEqual(worker,asset,'built service worker changes identity');
    put('assets/extra.js','left over');
    assert.notEqual(await buildIdentity(dist),worker,'extra served file changes identity');
    put('regression-build.json','{}');
    const stamped=await buildIdentity(dist);
    put('regression-build.json','{"changed":true}');
    assert.equal(await buildIdentity(dist),stamped,'the stamp written after hashing is excluded');
    assert.deepEqual(await listFiles(dist),['app-shell-assets/b.css','assets/app-1.js','assets/extra.js','index.html','regression-build.json','service-worker.js']);
    fs.rmSync(path.join(dist,'index.html'));
    await assert.rejects(buildIdentity(dist),/no index.html/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
