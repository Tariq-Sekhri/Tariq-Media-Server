const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');

const requests = load('app/lib/watch-requests.ts');

test('catalog resolution and the queue share one subtree request', async () => {
  requests.clearSharedRequests();
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json([{ path: 'TV/Show/Season 1/e1.mkv' }]); };
  const url = requests.librarySubtreeUrl('', 'TV/Show');
  const [first, second] = await Promise.all([requests.sharedJson(url, fetcher), requests.sharedJson(url, fetcher)]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(url, '/api/library?under=TV%2FShow');
});

test('a failed shared request is retried instead of cached', async () => {
  requests.clearSharedRequests();
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true }); };
  await assert.rejects(requests.sharedJson('/x', fetcher), (error) => error.status === 503);
  assert.deepEqual(await requests.sharedJson('/x', fetcher), { ok: true });
  assert.equal(calls, 2);
});

test('shared requests expire so later plays see fresh state', async () => {
  requests.clearSharedRequests();
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json(calls); };
  assert.equal(await requests.sharedJson('/s', fetcher, 1_000), 1);
  assert.equal(await requests.sharedJson('/s', fetcher, 10_000), 1);
  assert.equal(await requests.sharedJson('/s', fetcher, 20_000), 2);
});

test('queue scopes drop nested subtrees and fall back to the library only when needed', () => {
  assert.deepEqual([...requests.queueFetchScopes(['TV/Show', 'TV/Show/Season 2', undefined])], ['TV/Show']);
  assert.deepEqual([...requests.queueFetchScopes(['TV/Show', 'Movies/Film'])], ['TV/Show', 'Movies/Film']);
  assert.deepEqual([...requests.queueFetchScopes(['TV/Show', ''])], ['']);
  assert.deepEqual([...requests.queueFetchScopes([undefined])], []);
});

test('custom queues fetch the deepest folder shared by their items', () => {
  assert.equal(requests.commonFolder(['TV/Show/Season 1/a.mkv', 'TV/Show/Season 2/b.mkv']), 'TV/Show');
  assert.equal(requests.commonFolder(['TV/Show/a.mkv', 'Movies/b.mkv']), '');
  assert.equal(requests.commonFolder(['Music/Album/a.mp3']), 'Music/Album');
});
