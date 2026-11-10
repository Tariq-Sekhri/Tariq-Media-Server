const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage } = require('./load-ts.cjs');

function harness() {
  let now = 1_000;
  let observer;
  const records = [];
  class FakeDate extends Date { static now() { return now; } }
  const trace = load('app/lib/playback-trace.ts', {
    Date: FakeDate, crypto: { randomUUID: () => 'attempt-one' },
    window: { location: { href: 'https://example.test/' } },
    performance: { timeOrigin: 0 },
    PerformanceObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {} disconnect() { this.disconnected = true; }
    },
    setTimeout: () => 1, clearTimeout() {},
  });
  trace.configurePlaybackTraceReporter((event, duration, details) => records.push({ event, duration, ...details }));
  return { trace, records, time(value) { now = value; },
    resource(entry) { observer.callback({ getEntries: () => [entry] }); } };
}

test('the click clock survives a delayed catalog-to-episode navigation without restarting', () => {
  const h = harness();
  const attempt = h.trace.beginPlaybackTrace({ trigger: 'catalog_play' });
  const params = new URLSearchParams();
  h.trace.writePlaybackTrace(params, attempt);
  h.time(6_000);
  h.trace.traceFromParams(params);
  h.time(14_000);
  h.trace.playbackTracePhase('playback_started');
  assert.equal(h.records.at(-1).duration, 13_000);
  assert.equal(h.records.at(-1).attempt_id, attempt.id);
  assert.equal(h.records.at(-1).click_started_at_ms, 1_000);
  assert.equal(h.records.filter(record => record.event === 'play_click').length, 1);
});

test('requests distinguish headers from slow body parsing without reading the body early', async () => {
  const h = harness();
  h.trace.beginPlaybackTrace();
  h.time(1_100);
  const request = h.trace.startPlaybackRequest('/api/library?token=secret&folder=Example', {});
  let reads = 0;
  const response = new Response('{}');
  response.json = async () => { reads++; h.time(8_100); return { entries: [] }; };
  h.time(3_100);
  request.response(response);
  assert.equal(reads, 0);
  assert.equal(h.records.at(-1).request_duration_ms, 2_000);
  assert.equal(h.records.at(-1).event, 'play_request_headers');
  await response.json();
  const resolved = h.records.at(-1);
  assert.equal(resolved.event, 'play_request_resolved');
  assert.equal(resolved.duration, 7_100);
  assert.equal(resolved.request_duration_ms, 7_000);
  assert.equal(resolved.body_read_parse_ms, 5_000);
  assert.equal(resolved.endpoint, '/api/library');
  assert.equal(resolved.request_id, h.records.find(record => record.event === 'play_request_started').request_id);
  assert.ok(!JSON.stringify(h.records).includes('secret'));
});

test('a late request failure keeps its original attempt after a new click', () => {
  const h = harness();
  const first = h.trace.beginPlaybackTrace();
  const request = h.trace.startPlaybackRequest('/api/library', {});
  h.time(2_000);
  h.trace.resumePlaybackTrace({ id: 'attempt-two', startedAt: 2_000 });
  h.time(3_000);
  request.failed(new DOMException('Cancelled', 'AbortError'));
  assert.equal(h.records.at(-1).event, 'play_request_failed');
  assert.equal(h.records.at(-1).attempt_id, first.id);
  assert.equal(h.records.at(-1).duration, 2_000);
  assert.notEqual(h.trace.currentPlaybackTrace().id, first.id);
});

test('resource timings capture media requests while excluding telemetry and URL credentials', () => {
  const h = harness();
  h.trace.beginPlaybackTrace();
  h.time(2_000);
  const resource = { name: 'https://example.test/api/transcode?token=secret', startTime: 1_100,
    duration: 800, responseStart: 1_600, responseEnd: 1_900, initiatorType: 'fetch', transferSize: 123, decodedBodySize: 100 };
  h.resource(resource);
  const record = h.records.at(-1);
  assert.equal(record.event, 'play_request_resource');
  assert.equal(record.request_start_elapsed_ms, 100);
  assert.equal(record.request_end_elapsed_ms, 900);
  assert.equal(record.headers_wait_ms, 500);
  assert.equal(record.download_ms, 300);
  assert.equal(record.endpoint, '/api/transcode');
  const count = h.records.length;
  h.resource({ ...resource, name: 'https://example.test/api/client-performance' });
  h.resource({ ...resource, startTime: 900 });
  assert.equal(h.records.length, count);
  assert.ok(!JSON.stringify(h.records).includes('secret'));
});

test('logging failures and expired trace URLs do not interfere with playback', () => {
  const h = harness();
  h.trace.configurePlaybackTraceReporter(() => { throw new Error('Logging unavailable'); });
  assert.doesNotThrow(() => h.trace.beginPlaybackTrace());
  h.time(130_000);
  assert.equal(h.trace.currentPlaybackTrace(), undefined);
  assert.equal(h.trace.traceFromParams(new URLSearchParams('playAttempt=old&playStartedAt=1000')), undefined);
  assert.equal(h.trace.startPlaybackRequest('/api/library', {}), undefined);
});

test('authenticated requests emit start, headers and body completion through existing telemetry', async () => {
  const h = harness();
  const sent = [];
  let requests = 0;
  const auth = load('app/lib/auth.ts', {
    localStorage: storage(), navigator: { platform: 'test', userAgent: 'test' },
    window: { location: { pathname: '/watch', search: '', hash: '' } },
    XMLHttpRequest: class { open() {} setRequestHeader() {} send(body) { sent.push(JSON.parse(body)); } },
    fetch: async () => {
      requests++;
      h.time(2_000);
      const response = new Response('{}');
      response.json = async () => { h.time(5_000); return { result: 'ok' }; };
      return response;
    },
  }, { './media': { API_BASE: '' }, './playback-trace': h.trace });
  auth.rememberSession('test-session', { id: 1, name: 'Test' });
  h.trace.beginPlaybackTrace();
  const response = await auth.authFetch('/api/library');
  assert.equal(requests, 1);
  const headers = sent.find(record => record.event === 'play_request_headers');
  assert.ok(headers);
  assert.equal(headers.duration_ms, 1_000);
  assert.equal((await response.json()).result, 'ok');
  assert.equal(sent.at(-1).event, 'play_request_resolved');
  assert.equal(sent.at(-1).duration_ms, 4_000);
  assert.equal(sent.at(-1).details.request_duration_ms, 4_000);
  assert.ok(sent.every(record => !JSON.stringify(record).includes('test-session')));
});
