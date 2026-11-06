/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage, libraryPlayback } = require('./load-ts.cjs');
const media = load('app/lib/media.ts');
const search = load('app/lib/search.ts', {}, { './media': media });
const queue = load('app/lib/playback-queue.ts', {}, { './media': media, './search': search });
const item = (name, kind = 'audio') => ({ id: name, path: `Lib/${name}`, parent: 'Lib', name, kind, src: `/media/Lib/${name}`, size: '', tags: [], updated: '', owner: '', tone: '' });
const source = { version: 1, section: 'library', folder: 'Lib', search: '', globalSearch: false, tags: [], sort: 'name', direction: 'asc', method: 'shuffle', seed: 'fixed', anchor: 'Lib/a', returnUrl: '/?folder=Lib&sort=name', startedAt: 1000 };
function harness(saved = storage()) {
  return { saved, session: load('app/lib/playback-session.ts', { window: {}, sessionStorage: saved }, { './playback-queue': queue, './watch-progress': load('app/lib/watch-progress.ts', {}, { './library-playback': libraryPlayback({ sleep: { startFresh: true } }) }) }) };
}
function start(s, extra = {}) {
  const a = item('a'), b = item('b', 'video'), c = item('c');
  return s.startPlaybackSession({ userId: 7, item: a, queue: [a, b, c], source, returnUrl: source.returnUrl, complete: true, time: 0, playing: true, ...extra });
}

test('a fresh-start library keeps an active handoff position but restarts at zero after restoration', () => {
  const { session: s, saved } = harness();
  const audio = { ...item('rain.mp3'), path: 'Sleep/artist/rain.mp3', parent: 'Sleep/artist' };
  start(s, { item: audio, time: 0 });
  s.checkpointPlaybackSession(audio, 120, true);
  assert.equal(s.playbackSessionSnapshot().time, 120);
  s.setPlaybackSession({ ...s.playbackSessionSnapshot(), handoff: true });
  assert.equal(JSON.parse(saved.getItem('tms:playback-session:v1:7')).time, 0);
  assert.equal(harness(saved).session.restorePlaybackSession(7).time, 0);
});

test('mixed queue round trip preserves order, shuffle anchor, source and return destination', () => {
  const { session: s, saved } = harness();
  const original = start(s);
  const video = s.selectPlaybackItem(original, original.queue[1]);
  s.setPlaybackSession(video);
  const url = new URL(s.playbackWatchUrl(video), 'http://tms.test');
  assert.equal(url.pathname, '/watch');
  assert.equal(url.searchParams.get('kind'), 'video');
  assert.equal(url.searchParams.get('return'), source.returnUrl);
  assert.equal(queue.readQueueSource(url.searchParams).anchor, 'Lib/a');
  const restored = harness(saved).session.restorePlaybackSession(7);
  assert.equal(restored.item.path, 'Lib/b');
  assert.deepEqual(Array.from(restored.queue, x => x.path), ['Lib/a', 'Lib/b', 'Lib/c']);
  const audio = s.selectPlaybackItem(restored, restored.queue[2]);
  assert.equal(audio.item.kind, 'audio');
  assert.equal(audio.returnUrl, source.returnUrl);
  assert.equal(audio.source.seed, 'fixed');
});

test('checkpoints survive queue metadata updates without notifying React or resetting resume', () => {
  const { session: s, saved } = harness();
  const original = start(s);
  let renders = 0;
  const unsubscribe = s.subscribePlaybackSession(() => renders++);
  s.checkpointPlaybackSession(original.item, 42, false);
  assert.equal(renders, 0);
  s.setPlaybackSession({ ...s.playbackSessionSnapshot(), queue: original.queue.map(x => ({ ...x, duration: 99 })) });
  const restored = harness(saved).session.restorePlaybackSession(7);
  assert.equal(restored.time, 42);
  assert.equal(restored.playing, false);
  unsubscribe();
});

test('outgoing player cleanup cannot overwrite the next selected track', () => {
  const { session: s } = harness();
  const original = start(s);
  s.setPlaybackSession(s.selectPlaybackItem(original, original.queue[1]));
  s.checkpointPlaybackSession(original.item, 999, false);
  assert.equal(s.playbackSessionSnapshot().item.path, 'Lib/b');
  assert.equal(s.playbackSessionSnapshot().time, 0);
});

test('native video to audio handoff autoplays once; ordinary reload restores paused', () => {
  const { session: s, saved } = harness();
  start(s, { handoff: true, time: 12 });
  const afterNavigation = harness(saved).session;
  const restored = afterNavigation.restorePlaybackSession(7);
  assert.equal(restored.playing, true);
  assert.equal(restored.handoff, false);
  afterNavigation.setPlaybackSession(restored);
  assert.equal(harness(saved).session.restorePlaybackSession(7).playing, false);
});

test('session restoration is scoped to the signed-in user and expires', () => {
  const { session: s, saved } = harness();
  start(s);
  assert.equal(harness(saved).session.restorePlaybackSession(8), null);
  const raw = JSON.parse(saved.getItem('tms:playback-session:v1:7'));
  raw.savedAt = 0;
  saved.setItem('tms:playback-session:v1:7', JSON.stringify(raw));
  assert.equal(harness(saved).session.restorePlaybackSession(7), null);
});

test('close removes persisted playback so a later navigation cannot resurrect it', () => {
  const { session: s, saved } = harness();
  start(s);
  s.setPlaybackSession(null);
  assert.equal(harness(saved).session.restorePlaybackSession(7), null);
});

test('return destinations reject external URLs and Watch loops', () => {
  const { session: s } = harness();
  for (const url of ['https://example.com', '//example.com', '/\\example.com', '/watch?src=x']) assert.equal(s.playbackReturnUrl(url), '/');
  assert.equal(s.playbackReturnUrl('/?section=recent&tag=Music'), '/?section=recent&tag=Music');
});

test('storage failures preserve in-memory playback and queue transitions', () => {
  const { session: s } = harness({ getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('blocked'); } });
  const original = start(s);
  s.setPlaybackSession(s.selectPlaybackItem(original, original.queue[1]));
  assert.equal(s.playbackSessionSnapshot().item.kind, 'video');
});

test('offline visual transitions retain bundle identity and the complete mixed queue', () => {
  const { session: s } = harness();
  const video = { ...item('local', 'video'), offline: { bundleId: 'bundle', fileId: 'file' } };
  const original = start(s, { source: undefined });
  const url = new URL(s.playbackWatchUrl(s.selectPlaybackItem(original, video)), 'http://tms.test');
  assert.equal(url.searchParams.get('offlineBundle'), 'bundle');
  assert.equal(url.searchParams.get('offlineFile'), 'file');
  assert.equal(url.searchParams.has('src'), false);
  assert.equal(url.searchParams.get('queue'), 'custom');
});
