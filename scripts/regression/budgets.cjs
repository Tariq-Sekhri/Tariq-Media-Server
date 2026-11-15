'use strict';
const budgets = Object.freeze({ 'direct-video':[1500,3000], 'cold-remux':[3000,5000], transcode:[5000,8000], 'prepared-next':[750,1500], 'audio-warm':[750,1500], 'audio-cold':[1500,3000], 'image-warm':[250,750], 'image-cold':[1000,2000], 'first-art':[750,1500], 'viewport-art':[1500,3000], queue:[1000,2000], pip:[250,750], gap:[150,500] });
function percentile(values, p) { if (!values.length) return null; const s = [...values].sort((a,b)=>a-b); if (p === 0.5 && s.length % 2 === 0) return (s[s.length/2-1]+s[s.length/2])/2; return s[Math.max(0,Math.ceil(p*s.length)-1)]; }
function compatible(a,b) { return ['scenarioId','budget','measurementLevel','device','fixtureVersion','cacheMode','runtimeProfile','scenarioVersion'].every(k => typeof a?.[k] === 'string' && a[k] && a[k] === b?.[k]); }
function assess(meta, attempts, baseline) {
  if (!budgets[meta.budget]) throw new Error('Unknown budget');
  const valid = attempts.filter(a => a.status === 'ok' && Number.isFinite(a.ms) && a.ms >= 0);
  const invalid = attempts.filter(a => !valid.includes(a));
  const times = valid.map(a => a.ms), median = percentile(times,.5), p95 = percentile(times,.95), worst = times.length ? Math.max(...times) : null;
  const [warning, failure] = budgets[meta.budget];
  const absoluteFailures = valid.filter(a => a.ms >= failure).length;
  const absoluteWarnings = valid.filter(a => a.ms >= warning && a.ms < failure).length;
  let relative = 'unavailable';
  if (baseline) {
    if (!compatible(meta, baseline.metadata) || !Number.isFinite(baseline.median) || baseline.median < 0) relative = 'incompatible';
    else if (median !== null) relative = median >= baseline.median * 1.5 && median - baseline.median >= 300 ? 'fail' : median >= baseline.median * 1.25 && median - baseline.median >= 150 ? 'warn' : 'pass';
  }
  const status = invalid.length || absoluteFailures || relative === 'fail' ? 'fail' : relative === 'incompatible' ? 'blocked' : !valid.length ? 'blocked' : absoluteWarnings || relative === 'warn' ? 'warn' : 'pass';
  return {status, count:attempts.length, valid:valid.length, median, p95, worst, failures:invalid.length + absoluteFailures, absoluteWarnings, relative};
}
module.exports = { budgets, percentile, compatible, assess };
