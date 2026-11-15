'use strict';
const {inflateSync}=require('node:zlib');
// Android screencap and CDP Page.captureScreenshot emit non-interlaced 8-bit
// RGB/RGBA PNGs. Reject unsupported formats instead of silently treating an
// undecodable screenshot as evidence.
function decodePng(buffer){
  if(buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Not a PNG');
  let width,height,channels;const chunks=[];
  for(let pos=8;pos<buffer.length;){const size=buffer.readUInt32BE(pos),kind=buffer.toString('ascii',pos+4,pos+8),data=buffer.subarray(pos+8,pos+8+size);if(kind==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=data[9]===6?4:data[9]===2?3:0;if(data[8]!==8||data[12]!==0||!channels||width*height>20000000)throw Error('Unsupported PNG');}if(kind==='IDAT')chunks.push(data);pos+=size+12;}
  const packed=inflateSync(Buffer.concat(chunks)),stride=width*channels,pixels=Buffer.alloc(stride*height);
  if(packed.length!==(stride+1)*height)throw Error('Incomplete PNG');
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=packed[y*(stride+1)];if(filter>4)throw Error('Unknown PNG filter');for(let x=0;x<stride;x++){const at=y*stride+x,a=x>=channels?pixels[at-channels]:0,b=y?pixels[at-stride]:0,c=y&&x>=channels?pixels[at-stride-channels]:0;pixels[at]=(packed[y*(stride+1)+x+1]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;}}
  return {width,height,channels,pixels};
}
function checkRegion(buffer,region,expected){
  const image=decodePng(buffer);let count=0,matched=0;
  for(let fy=.15;fy<=.85;fy+=.1)for(let fx=.15;fx<=.85;fx+=.1){const x=Math.round((region.x+region.width*fx)*image.width),y=Math.round((region.y+region.height*fy)*image.height);if(x<0||x>=image.width||y<0||y>=image.height)continue;const at=(y*image.width+x)*image.channels,rgb=[...image.pixels.subarray(at,at+3)];count++;if(expected?rgb.every((v,i)=>Math.abs(v-expected[i])<=15):Math.max(...rgb)-Math.min(...rgb)>25&&Math.max(...rgb)>45)matched++;}
  return {verified:count>0&&matched/count>=.3,matched,sampled:count};
}

// Where a replaced element (img/canvas/video) actually paints its content,
// following CSS object-fit and object-position. `box` is the element's CSS
// content box (border and padding removed). Self-contained so it can be
// serialized into the WebView. Throws on values it cannot resolve exactly.
function objectContentRect(box,natural,fit,position){
  if(!(natural&&natural.width>0&&natural.height>0))throw Error('unknown-natural-size');
  if(!(box&&box.width>0&&box.height>0))throw Error('empty-content-box');
  fit=fit||'fill';
  const contain=Math.min(box.width/natural.width,box.height/natural.height);
  const scale={contain,cover:Math.max(box.width/natural.width,box.height/natural.height),none:1,'scale-down':Math.min(1,contain)}[fit];
  if(fit!=='fill'&&scale===undefined)throw Error('unsupported-object-fit:'+fit);
  const width=fit==='fill'?box.width:natural.width*scale,height=fit==='fill'?box.height:natural.height*scale;
  const keyword={left:0,top:0,center:50,right:100,bottom:100};
  const own=t=>Object.prototype.hasOwnProperty.call(keyword,t);
  const length=(token,free)=>{if(own(token))return free*keyword[token]/100;let m=/^(-?\d*\.?\d+)%$/.exec(token);if(m)return free*Number(m[1])/100;m=/^(-?\d*\.?\d+)px$/.exec(token);if(m)return Number(m[1]);if(token==='0')return 0;throw Error('unsupported-object-position:'+position);};
  let tokens=String(position||'50% 50%').trim().split(/\s+/);
  const vertical=t=>t==='top'||t==='bottom',horizontal=t=>t==='left'||t==='right';
  let x,y;const freeX=box.width-width,freeY=box.height-height;
  if(tokens.length===1)tokens=vertical(tokens[0])?['center',tokens[0]]:[tokens[0],'center'];
  if(tokens.length===2){
    if(vertical(tokens[0])||horizontal(tokens[1]))tokens=[tokens[1],tokens[0]];
    if(vertical(tokens[0])||horizontal(tokens[1]))throw Error('unsupported-object-position:'+position);
    x=length(tokens[0],freeX);y=length(tokens[1],freeY);
  }else if(tokens.length===4){
    if(vertical(tokens[0]))tokens=[tokens[2],tokens[3],tokens[0],tokens[1]];
    const [ex,ox,ey,oy]=tokens;
    if(!horizontal(ex)||!vertical(ey)||own(ox)||own(oy))throw Error('unsupported-object-position:'+position);
    x=ex==='left'?length(ox,freeX):freeX-length(ox,freeX);y=ey==='top'?length(oy,freeY):freeY-length(oy,freeY);
  }else throw Error('unsupported-object-position:'+position);
  return {x:box.x+x,y:box.y+y,width,height};
}

// Sample grid restricted to what is really painted: the drawn content clipped
// by the content box (object-fit: cover overflows) and the viewport. Each point
// carries its CSS viewport position and the matching source fraction (u,v).
function referenceSamples(box,drawn,viewport,steps){
  steps=steps||9;
  const left=Math.max(box.x,drawn.x,0),top=Math.max(box.y,drawn.y,0);
  const right=Math.min(box.x+box.width,drawn.x+drawn.width,viewport.width),bottom=Math.min(box.y+box.height,drawn.y+drawn.height,viewport.height);
  if(right-left<4||bottom-top<4)return [];
  const points=[];
  for(let j=1;j<=steps;j++)for(let i=1;i<=steps;i++){
    const x=left+(right-left)*i/(steps+1),y=top+(bottom-top)*j/(steps+1);
    points.push({x,y,u:(x-drawn.x)/drawn.width,v:(y-drawn.y)/drawn.height});
  }
  return points;
}

// Runs inside the WebView. Returns viewport geometry plus CSS-pixel sample
// points with the colours the element's own source has there, or {error}.
function collectReference(selector,objectContentRect,referenceSamples){
  try{
    const e=document.querySelector(selector);if(!e)return {error:'missing-element'};
    const vv=window.visualViewport;
    const viewport={width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:vv?vv.scale:1,offsetLeft:vv?vv.offsetLeft:0,offsetTop:vv?vv.offsetTop:0};
    const style=getComputedStyle(e),r=e.getBoundingClientRect(),n=v=>parseFloat(v)||0;
    const left=n(style.borderLeftWidth)+n(style.paddingLeft),top=n(style.borderTopWidth)+n(style.paddingTop);
    const box={x:r.left+left,y:r.top+top,width:r.width-left-n(style.borderRightWidth)-n(style.paddingRight),height:r.height-top-n(style.borderBottomWidth)-n(style.paddingBottom)};
    const tag=e.tagName;
    const natural=tag==='IMG'?{width:e.naturalWidth,height:e.naturalHeight}:tag==='VIDEO'?{width:e.videoWidth,height:e.videoHeight}:tag==='CANVAS'?{width:e.width,height:e.height}:null;
    if(!natural)return {error:'unsupported-element'};
    if(tag==='IMG'&&!e.complete)return {error:'image-incomplete'};
    const drawn=objectContentRect(box,natural,style.objectFit,style.objectPosition);
    const samples=referenceSamples(box,drawn,viewport);
    if(!samples.length)return {error:'content-not-visible'};
    const limit=256,shrink=Math.min(1,limit/Math.max(natural.width,natural.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(natural.width*shrink));canvas.height=Math.max(1,Math.round(natural.height*shrink));
    const ctx=canvas.getContext('2d');if(!ctx)return {error:'unreadable-source'};
    ctx.drawImage(e,0,0,canvas.width,canvas.height);
    const points=samples.map(p=>({x:p.x,y:p.y,rgb:[...ctx.getImageData(Math.min(canvas.width-1,Math.max(0,Math.floor(p.u*canvas.width))),Math.min(canvas.height-1,Math.max(0,Math.floor(p.v*canvas.height))),1,1).data].slice(0,3)}));
    return {viewport,content:drawn,fit:style.objectFit||'fill',points};
  }catch(error){return {error:String(error&&error.message||error)};}
}
const referenceExpression=selector=>`(${collectReference})(${JSON.stringify(selector)},${objectContentRect},${referenceSamples})`;
const viewportExpression=`(()=>{const vv=window.visualViewport;return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:vv?vv.scale:1,offsetLeft:vv?vv.offsetLeft:0,offsetTop:vv?vv.offsetTop:0};})()`;

// CSS viewport px -> capture px. Both captures must contain exactly the
// WebView viewport: CDP 'viewport' captures do by construction (at device or
// CSS scale); a 'display' (adb screencap) capture only when the edge-to-edge
// WebView fills the display. Anything else (insets, split screen, rotation,
// pinch zoom) has no established mapping and is reported, never guessed.
function captureMapping(image,viewport,capture){
  if(!viewport||![viewport.width,viewport.height,viewport.dpr].every(v=>Number.isFinite(v)&&v>0))return {error:'missing-viewport'};
  if(Math.abs((viewport.scale??1)-1)>1e-3||Math.abs(viewport.offsetLeft||0)>.5||Math.abs(viewport.offsetTop||0)>.5)return {error:'zoomed-viewport'};
  // innerWidth/innerHeight are whole CSS px, so allow one CSS px of rounding.
  const fits=scale=>{const slack=Math.ceil(scale)+1;return Math.abs(image.width-viewport.width*scale)<=slack&&Math.abs(image.height-viewport.height*scale)<=slack;};
  if(fits(viewport.dpr))return {scale:viewport.dpr,offsetX:0,offsetY:0};
  if(capture==='viewport'&&fits(1))return {scale:1,offsetX:0,offsetY:0};
  return {error:capture==='display'?'display-mapping-unavailable':'viewport-capture-size-mismatch'};
}
function checkReference(buffer,reference,capture){
  if(!reference||reference.error)return {verified:false,reason:reference?.error||'missing-reference'};
  const points=reference.points;
  if(!Array.isArray(points)||points.length<16)return {verified:false,reason:'missing-reference'};
  const colors=new Set(points.map(p=>p.rgb.map(c=>Math.floor(c/16)).join(',')));
  if(colors.size<5)return {verified:false,reason:'uninformative-reference'};
  let image;try{image=decodePng(buffer);}catch(error){return {verified:false,reason:'undecodable-capture'};}
  const mapping=captureMapping(image,reference.viewport,capture||'viewport');
  if(mapping.error)return {verified:false,reason:mapping.error,capture:{width:image.width,height:image.height}};
  let count=0,matched=0;
  for(const point of points){const x=Math.floor(mapping.offsetX+point.x*mapping.scale),y=Math.floor(mapping.offsetY+point.y*mapping.scale);if(x<0||y<0||x>=image.width||y>=image.height)continue;const at=(y*image.width+x)*image.channels,actual=[...image.pixels.subarray(at,at+3)],expected=point.rgb;count++;
    const energy=expected.reduce((s,v)=>s+v*v,0);if(energy<1000)continue;
    const scale=actual.reduce((s,v,i)=>s+v*expected[i],0)/energy;
    if(scale>=.3&&scale<=1.12&&actual.every((v,i)=>Math.abs(v-scale*expected[i])<24))matched++;
  }
  const verified=count>=16&&matched/count>=.6;
  return {verified,...(verified?{}:{reason:'pixels-mismatch'}),matched,sampled:count,scale:mapping.scale,verification:'reference-grid'};
}
// Both proofs are required: the CDP viewport capture has an exact CSS mapping,
// and the display capture shows the same pixels actually reached the screen.
function verifyScreens({reference,viewportCapture,displayCapture,viewportAfter}){
  if(!reference||reference.error)return {verified:false,reason:reference?.error||'missing-reference'};
  const v=reference.viewport;
  if(!viewportAfter||['width','height','dpr','scale','offsetLeft','offsetTop'].some(k=>viewportAfter[k]!==v[k]))return {verified:false,reason:'viewport-changed'};
  const viewport=viewportCapture?checkReference(viewportCapture,reference,'viewport'):{verified:false,reason:'viewport-capture-unavailable'};
  const display=displayCapture?checkReference(displayCapture,reference,'display'):{verified:false,reason:'display-capture-unavailable'};
  const verified=viewport.verified&&display.verified;
  return {verified,...(verified?{}:{reason:viewport.verified?'display:'+display.reason:'viewport:'+viewport.reason}),viewport,display,verification:'reference-grid'};
}
module.exports={decodePng,checkRegion,checkReference,captureMapping,objectContentRect,referenceSamples,collectReference,referenceExpression,viewportExpression,verifyScreens};
