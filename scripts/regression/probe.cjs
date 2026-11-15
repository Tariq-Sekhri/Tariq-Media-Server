'use strict';
// This function runs in the existing app document, never in a custom player.
async function probe(scenario) {
  const start = performance.now();
  const startedAtUtcMs = Date.now();
  const target = document.querySelector(scenario.clickSelector);
  if (!target || target.disabled || !target.getClientRects().length) return {status:'blocked', reason:'target-unavailable'};
  const result = () => {
    const root=scenario.shadowHostSelector?document.querySelector(scenario.shadowHostSelector)?.shadowRoot:document;
    if(scenario.shadowHostSelector&&root){return [...root.querySelectorAll(scenario.resultSelector)].find(e=>(e.currentSrc||e.src||'').includes(scenario.sourceIncludes)&&!e.paused)||root.querySelector(scenario.resultSelector);}
    return root?.querySelector(scenario.resultSelector);
  };
  const previous = result();
  const oldSource = previous && (previous.currentSrc || previous.src || '');
  const sourceMatches = el => {
    const source = el.currentSrc || el.src || '';
    return Boolean(source) && (!scenario.sourceIncludes || source.includes(scenario.sourceIncludes)) && (!scenario.requireSourceChange || source !== oldSource);
  };
  const visible = (el, pixelEvidence=false) => {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    const x = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const y = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    if (!x || !y) return false;
    // Canvas sits beneath intentional translucent player controls. When the
    // runner requires screenshot pixels, those pixels decide occlusion rather
    // than pointer hit testing (which sees transparent controls as opaque).
    if(pixelEvidence)return true;
    let exposed=0;
    for(const fx of [.2,.5,.8])for(const fy of [.2,.5,.8]){
      const px=Math.max(0,rect.left)+x*fx,py=Math.max(0,rect.top)+y*fy;
      const top=document.elementFromPoint(px,py);
      if(top&&(top===el||el.contains(top)||(style.pointerEvents==='none'&&top===el.parentElement)))exposed++;
    }
    return exposed>=3;
  };
  let first = null, frame = null, frameElement = null;
  let previousPixels = null;
  let sampleMonitor=null;
  target.click();
  const deadline = start + (scenario.timeoutMs || 15000);
  while (performance.now() < deadline) {
    const el = result();
    if (el && (scenario.kind === 'element' || sourceMatches(el))) {
      if (scenario.kind === 'image' && el.complete && el.naturalWidth > 0 && el.naturalHeight > 0 && visible(el)) {
        try { await el.decode(); if (sourceMatches(el) && visible(el)) return {status:'ok', ms:performance.now()-start, level:'decoded-visible-dom'}; } catch {}
      }
      if (scenario.kind === 'audio' && !el.paused && !el.error && el.readyState >= 3) {
        const src = el.currentSrc || el.src;
        if(scenario.verifyAudioSamples&&!sampleMonitor){
          if(typeof el.captureStream!=='function'||!window.AudioContext)return {status:'blocked',reason:'audio-sample-capture-unavailable'};
          const context=new AudioContext(),stream=el.captureStream(),analyser=context.createAnalyser(),sink=context.createGain();
          analyser.fftSize=2048;sink.gain.value=0;
          const source=context.createMediaStreamSource(stream);source.connect(analyser);analyser.connect(sink);sink.connect(context.destination);
          await context.resume();sampleMonitor={context,stream,analyser};
        }
        if (first && first.el === el && first.src === src && el.currentTime > first.time + (scenario.minimumAdvanceSeconds || 0.1)) {
          if(sampleMonitor){const samples=new Float32Array(2048);sampleMonitor.analyser.getFloatTimeDomainData(samples);let real=0,imaginary=0,energy=0;for(let i=0;i<samples.length;i++){const angle=2*Math.PI*440*i/sampleMonitor.context.sampleRate;real+=samples[i]*Math.cos(angle);imaginary+=samples[i]*Math.sin(angle);energy+=samples[i]*samples[i];}if(energy/samples.length<1e-10||2*(real*real+imaginary*imaginary)/(samples.length*energy)<.45){await new Promise(r=>setTimeout(r,25));continue;}sampleMonitor.stream.getTracks().forEach(t=>t.stop());await sampleMonitor.context.close();}
          return {status:'ok', ms:performance.now()-start, startedAtUtcMs, level:sampleMonitor?'client-decoded-fixture-tone':'audio-timeline',audioSamplesVerified:!!sampleMonitor,audibleOutput:'unverified'};
        }
        if (!first || first.el !== el || first.src !== src) first = {el,src,time:el.currentTime};
      }
      const display=scenario.displaySelector ? document.querySelector(scenario.displaySelector) : el;
      if (scenario.kind === 'video' && !el.paused && !el.error && el.readyState >= 2 && display && visible(display,scenario.verifyPixels) && typeof el.requestVideoFrameCallback === 'function') {
        if (frameElement !== el) { frame = null; frameElement = el; }
        if (!frame || frame.source !== (el.currentSrc || el.src)) {
          frame = {source:el.currentSrc || el.src, count:0, mediaTime:-1, progressing:false};
          const captured = frame;
          const onFrame = (_now, metadata) => { if (frame !== captured) return; if (captured.count && metadata.mediaTime > captured.mediaTime) captured.progressing = true; captured.count++; captured.mediaTime = metadata.mediaTime; if (!captured.progressing) el.requestVideoFrameCallback(onFrame); };
          el.requestVideoFrameCallback(onFrame);
        }
        if (frame.progressing && frame.source === (el.currentSrc || el.src) && visible(display,scenario.verifyPixels)) {
          if(scenario.displaySelector){
            try {
              const ctx=display.getContext('2d');
              const pixels=ctx.getImageData(0,0,display.width,display.height).data;
              let signature=0,light=0;for(let i=0;i<pixels.length;i+=256){signature=(signature+pixels[i]*(i%97+1)+pixels[i+1]*3+pixels[i+2]*7)%2147483647;light+=pixels[i]+pixels[i+1]+pixels[i+2];}
              if(light===0){await new Promise(r=>setTimeout(r,25));continue;}
              if(previousPixels===null||previousPixels===signature){previousPixels=signature;await new Promise(r=>setTimeout(r,25));continue;}
            }catch{return {status:'failed',reason:'canvas-output-unverifiable'};}
          }
          return {status:'ok', ms:performance.now()-start, level:'visible-video-frame-callback',canvasPixelsVerified:!!scenario.displaySelector};
        }
      }
      if (scenario.kind === 'element' && visible(el)) return {status:'ok', ms:performance.now()-start, level:'visible-dom'};
    }
    if (!el || (scenario.kind === 'audio' && (el.paused || el.error || !sourceMatches(el)))) first = null;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  frame = null;
  if(sampleMonitor){sampleMonitor.stream.getTracks().forEach(t=>t.stop());await sampleMonitor.context.close();}
  return {status:'failed', reason:'probe-timeout'};
}
module.exports = {probe};
