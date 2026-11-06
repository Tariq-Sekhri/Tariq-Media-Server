/* eslint-disable @typescript-eslint/no-require-imports -- The Node test harness uses CommonJS. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, libraryPlayback } = require('./load-ts.cjs');
const media = load('app/lib/media.ts');
const search = load('app/lib/search.ts', {}, { './media': media });
const queue = () => load('app/lib/playback-queue.ts', {}, { './media': media, './search': search });
const item = (name, extra = {}) => ({ id: name, name, path: `Lib/${name}`, parent: 'Lib', kind: 'video', src: `/media/Lib/${name}`, tags: [], size: '', updated: '', owner: '', tone: '', ...extra });
const source = (extra = {}) => ({ version: 1, section: 'library', folder: 'Lib', search: '', globalSearch: false, tags: [], sort: 'name', direction: 'asc', method: 'item', returnUrl: '/?folder=Lib', startedAt: 1000, ...extra });
const names = (items) => Array.from(items, x => x.name);

test('clicking the second item preserves mixed media order, filters, and position', () => {
  const q = queue();
  const entries = [item('c', { kind: 'audio', tags: ['keep'] }), item('a', { kind: 'image', tags: ['keep'] }), item('b', { tags: ['keep'], catalogKind: 'movie' }), item('skip')];
  const result = q.buildPlaybackQueue(entries, source({ tags: ['keep'] }));
  assert.deepEqual(names(result), ['a', 'b', 'c']);
  assert.equal(result.findIndex(x => x.name === 'b') + 1, 2);
});

test('Recent queues across locations, preserves its entry order after access updates', () => {
  const q = queue();
  const entries = [item('a', { lastOpenedAt: 10 }), item('b', { path: 'Other/b', parent: 'Other', lastOpenedAt: 30 }), item('unopened')];
  const context = q.queueSourceForItem(source({ section: 'recent', folder: undefined, returnUrl: '/?section=recent' }), entries[0]);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, context)), ['b', 'a']);
  entries[0].lastOpenedAt = 9999;
  assert.deepEqual(names(q.buildPlaybackQueue(entries, context)), ['b', 'a']);
});

test('Last opened ordering survives playing an unopened item and advancing', () => {
  const q = queue();
  const a = item('a', { addedAt: 100 }), b = item('b', { lastOpenedAt: 200 });
  let context = q.queueSourceForItem(source({ sort: 'opened' }), a);
  assert.deepEqual(names(q.buildPlaybackQueue([a, b], context)), ['a', 'b']);
  a.lastOpenedAt = 9999;
  context = q.queueSourceForItem(context, b);
  b.lastOpenedAt = 10000;
  assert.deepEqual(names(q.buildPlaybackQueue([a, b], context)), ['a', 'b']);
});

test('paged Shuffle samples an unloaded page and starts without loading the full queue', async () => {
  const q = queue();
  const calls = [];
  let selected;
  await q.startPagedShuffle(1000, source({ method: 'shuffle' }), async offset => {
    calls.push(offset);
    return [item('unloaded')];
  }, (entry, context) => { selected = entry; assert.equal(context.anchor, entry.path); }, () => 0.9);
  assert.deepEqual(calls, [900]);
  assert.equal(selected.name, 'unloaded');
});

test('rebuilding uses complete folders but searches/tag filters request recursive inventory', () => {
  const q = queue();
  const folder = new URL(q.queueLibraryUrl(source()), 'http://tms.test');
  assert.equal(folder.searchParams.get('limit'), '999999');
  assert.equal(folder.searchParams.get('folder'), 'Lib');
  assert.equal(folder.searchParams.get('metadata'), 'false');
  assert.equal(new URL(q.queueLibraryUrl(source({ tags: ['keep'] })), 'http://tms.test').searchParams.has('folder'), false);
  assert.equal(new URL(q.queueLibraryUrl(source({ section: 'recent' })), 'http://tms.test').searchParams.has('folder'), false);
});

test('URL alone recovers source, filters, sorting, method and return after queue advance', () => {
  const q = queue();
  for (const method of ['item', 'all', 'shuffle']) {
    const context = source({ method, search: 'type:video', tags: ['Favorites', 'fun'], sort: 'size', direction: 'desc', seed: 'seed', anchor: 'Lib/b', returnUrl: '/?section=recent&tag=fun' });
    const params = new URLSearchParams({ path: 'Lib/c' });
    q.writeQueueSource(params, context);
    const restored = q.readQueueSource(new URLSearchParams(params.toString()));
    assert.equal(JSON.stringify(restored), JSON.stringify(context));
    assert.equal(params.get('return'), context.returnUrl);
    assert.equal(params.get('path'), 'Lib/c');
  }
});

test('Play all navigates before deferred queue work and starts with the sorted first item', () => {
  const q = queue();
  let selected;
  q.startPlaybackQueue([item('a'), item('b')], source({ method: 'all' }), (entry, context) => { selected = entry; assert.equal(context.method, 'all'); });
  assert.equal(selected.name, 'a');
});

test('Shuffle starts immediately at a random item and rebuilds a stable full order after advance', () => {
  const q = queue();
  let context;
  q.startPlaybackQueue([item('a'), item('b'), item('c')], source({ method: 'shuffle', seed: 'fixed' }), (entry, next) => { assert.equal(entry.name, 'c'); context = next; }, () => 0.99);
  const entries = [item('a'), item('b'), item('c'), item('d')];
  const first = q.buildPlaybackQueue(entries, context);
  assert.equal(first[0].name, 'c');
  assert.equal(new Set(first.map(x => x.path)).size, 4);
  const params = new URLSearchParams({ path: first[1].path });
  q.writeQueueSource(params, context);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, q.readQueueSource(params))), names(first));
});

test('folder, recursive tag/search, playlist, Favorites and New scopes exclude unrelated items', () => {
  const q = queue();
  const entries = [item('a', { favorite: true, tags: ['keep'], addedAt: 999 }), item('b', { parent: 'Lib/Sub', path: 'Lib/Sub/b', tags: ['keep'] }), item('c', { parent: 'Other', path: 'Other/c', tags: ['keep'], addedAt: -100000 }), item('folder', { kind: 'folder' })];
  assert.deepEqual(names(q.buildPlaybackQueue(entries, source())), ['a']);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, source({ tags: ['keep'] }))), ['a', 'b']);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, source({ search: 'tag:keep', tags: ['Favorites'] }))), ['a']);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, source({ section: 'playlists', playlistPaths: ['Other/c'] }))), ['c']);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, source({ section: 'favorites' }))), ['a']);
  assert.deepEqual(names(q.buildPlaybackQueue(entries, source({ section: 'new', startedAt: 87000 }))), ['a']);
});

test('invalid queue URLs do not crash playback or allow external return destinations', () => {
  const q = queue();
  assert.equal(q.readQueueSource(new URLSearchParams('queueSource=broken')), undefined);
  assert.equal(q.readQueueSource(new URLSearchParams({ queueSource: JSON.stringify(source({ returnUrl: '//evil.test' })) })), undefined);
});

test('cold loader rebuilds the full filtered queue using inherited tags and account favorites', async () => {
  const q = queue();
  const entries = [
    { path: 'Lib/a.jpg', name: 'a.jpg', kind: 'file', size: 1, created_at: 1 },
    { path: 'Lib/b.mp4', name: 'b.mp4', kind: 'file', size: 2, created_at: 1 },
    { path: 'Lib/c.mp3', name: 'c.mp3', kind: 'file', size: 3, created_at: 1 },
    { path: 'Other/no.mp4', name: 'no.mp4', kind: 'file', size: 1, created_at: 1 },
  ];
  const calls = [];
  const result = await q.loadPlaybackQueue(source({ tags: ['keep', 'Favorites'] }), async url => {
    calls.push(url);
    return Response.json(url === '/api/user-state' ? { tags: { Lib: ['keep'] }, favorites: entries.map(x => x.path) } : entries);
  });
  assert.deepEqual(names(result.queue), ['a.jpg', 'b.mp4', 'c.mp3']);
  assert.equal(result.queue[1].kind, 'video');
  assert.equal(calls.length, 2);
});

test('cold loader respects the same library visibility as the signed-in browse view', async () => {
  const q = queue();
  const entries = ['Allowed', 'Hidden'].map(lib => ({ path: `${lib}/a.mp4`, name: 'a.mp4', kind: 'file', size: 1, created_at: 1 }));
  const result = await q.loadPlaybackQueue(source({ globalSearch: true }), async url => Response.json(
    url === '/api/user-state' ? {} : url === '/api/libraries' ? { Allowed: { members: [{ name: 'Viewer', can_view: true }] }, Hidden: { members: [] } } : entries
  ), undefined, { name: 'viewer', is_admin: false });
  assert.deepEqual(Array.from(result.queue, x => x.path), ['Allowed/a.mp4']);
});

test('failed full-queue requests reject instead of fabricating a partial queue', async () => {
  await assert.rejects(queue().loadPlaybackQueue(source(), async () => new Response('', { status: 503 })), /503/);
});

// Exercise the production navigation functions as well as the queue module.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function pageFunction(file, name, globals) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(declaration, `${name} exists in the production page`);
  return vm.runInNewContext(ts.transpileModule(`(${declaration.initializer.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { URLSearchParams, ...globals });
}

test('production Play all starts immediately and leaves player selection to the active item', () => {
  const q = queue();
  let selected;
  const start = pageFunction('app/page.tsx', 'playVisibleQueue', {
    playableVisible: [item('first', { kind: 'audio' }), item('second')], section: 'library',
    currentQueueSource: method => source({ method }), isServerPagedFolder: true, serverHasMore: true, serverTotal: 1000,
    ...q, playVideo: (...args) => { selected = args; },
    authFetch: () => { throw new Error('must not wait for inventory'); },
  });
  start(false);
  assert.equal(selected[0].name, 'first');
  assert.equal(selected[5].method, 'all');
});

test('production item click queues audio and movies using the view context', () => {
  for (const entry of [item('song', { kind: 'audio' }), item('movie', { catalogKind: 'movie' })]) {
    let selected;
    const open = pageFunction('app/page.tsx', 'openItem', {
      currentQueueSource: () => source(), playVideo: (...args) => { selected = args; },
      setPreview: () => { throw new Error('playable media must enter playback'); },
    });
    open(entry);
    assert.equal(selected[0], entry);
    assert.equal(selected[5].method, 'item');
  }
});

test('production audio click starts a shared mini session without navigating to Watch', () => {
  const entry = item('song', { kind: 'audio' });
  let started, accessed;
  const play = pageFunction('app/page.tsx', 'playVideo', {
    playsAlongside: () => false, libraries: {}, sessionUser: { id: 7 }, savesWatchProgress: load('app/lib/watch-progress.ts', {}, { './library-playback': libraryPlayback({ sleep: { startFresh: true } }) }).savesWatchProgress, queueSourceForItem: queue().queueSourceForItem,
    readPlayback: () => ({ position: 5, duration: 100, updated: 1 }),
    readLocalWatchProgress: () => ({ [entry.path]: { position: 25, duration: 100, updated: 2 } }),
    window: { location: { pathname: '/', search: '?folder=Lib', assign() { throw Error('audio must stay in browse'); } } },
    startPlaybackSession: input => { started = input; }, recordAccess: path => { accessed = path; },
  });
  play(entry, undefined, undefined, undefined, undefined, source());
  assert.equal(started.item, entry);
  assert.equal(started.time, 25);
  assert.equal(started.source.method, 'item');
  assert.equal(started.complete, false);
  assert.equal(started.returnUrl, '/?folder=Lib');
  assert.equal(accessed, entry.path);
  const fresh = { ...entry, path: 'Sleep/artist/song.mp3', parent: 'Sleep/artist' };
  play(fresh, 90, undefined, undefined, undefined, source());
  assert.equal(started.time, 0);
  assert.equal(accessed, fresh.path);
});

test('production Watch switches to mini audio with the exact mixed queue and leaves Watch in place', () => {
  const s = load('app/lib/playback-session.ts', { window: {}, sessionStorage: require('./load-ts.cjs').storage() }, { './playback-queue': queue(), './watch-progress': load('app/lib/watch-progress.ts', {}, { './library-playback': libraryPlayback({ sleep: { startFresh: true } }) }) });
  const video = item('a'), audio = item('b', { kind: 'audio' });
  const entries = [video, audio];
  s.startPlaybackSession({ userId: 7, item: video, queue: entries, source: source(), returnUrl: '/?folder=Lib', complete: true, time: 0, playing: true });
  let destination, stopped = 0;
  const ref = current => ({ current });
  const go = pageFunction('app/watch/page.tsx', 'goToQueueItem', {
    ...s, companionRef: { current: null }, details: { src: video.src, sourcePath: video.path, kind: 'video' }, queue: entries,
    detailsMediaPath: d => d.sourcePath, getSessionUser: () => ({ id: 7 }),
    qualityRequestRef: ref(0), videoRef: ref({ currentTime: 12, duration: 100, pause() { stopped++; } }),
    backgroundAudioRef: ref(null), preserveHiddenControlsRef: ref(false), controlsVisibleRef: ref(false),
    continueBackgroundAudioRef: ref(false), audioOnlyRef: ref(false), nativeBackgroundRef: ref(false),
    streamOffsetRef: ref(0), sourceDurationRef: ref(100), hlsRef: ref(null), qualityBusyRef: ref(false), exitingRef: ref(false),
    queueNavigationPathRef: ref(null),
    saveProgress() {}, sendPlaybackActivity() {}, stopActiveTranscode() {}, setQualityBusy() {},
    readLocalWatchProgress: () => ({ [audio.path]: { position: 8, duration: 100, updated: 10 } }),
    closeWatch: url => { destination = url; },
    window: { location: { replace() { throw Error('audio handoff must not reload the page'); } } },
  });
  go(audio);
  assert.equal(destination, '/?folder=Lib');
  assert.equal(stopped, 1);
  assert.equal(s.playbackSessionSnapshot().item, audio);
  assert.equal(s.playbackSessionSnapshot().queue, entries);
  assert.equal(s.playbackSessionSnapshot().time, 8);
  assert.equal(s.playbackSessionSnapshot().handoff, true);
});

test('production watch navigation retains the original source and return for mixed movie queues', () => {
  const q = queue();
  const context = source({ method: 'shuffle', seed: 'fixed', anchor: 'Lib/a' });
  const paramsFromItem = pageFunction('app/watch/page.tsx', 'paramsForItem', {
    ...q, ...media, watchLocationSearch: () => '?return=%2Fwrong',
  });
  const params = paramsFromItem(item('b', { catalogKind: 'movie' }), { queueSource: context, folder: 'Lib', kind: 'video', catalogKind: 'movie', queueLabel: 'Shuffled' });
  assert.equal(JSON.stringify(q.readQueueSource(params)), JSON.stringify(context));
  assert.equal(params.get('return'), '/?folder=Lib');
  assert.equal(params.get('queueLabel'), 'Shuffled');
});

test('production queue application permits movies in an explicit source queue', () => {
  let applied;
  const context = {
    useCallback: fn => fn,
    detailsRef: { current: { kind: 'video', catalogKind: 'movie', queueSource: source() } },
    isMovieWatch: media.isMovieWatch, setQueue: value => { applied = value; },
  };
  const apply = pageFunction('app/watch/page.tsx', 'applyQueue', context);
  const items = [item('movie'), item('song', { kind: 'audio' })];
  apply(items);
  assert.equal(applied, items);
});

test('all six browse sort fields retain their ascending and descending order', () => {
  const q = queue();
  const a = item('a', { sizeBytes: 1, duration: 1, addedAt: 1, lastOpenedAt: 1, kind: 'audio' });
  const b = item('b', { sizeBytes: 2, duration: 2, addedAt: 2, lastOpenedAt: 2, kind: 'video' });
  for (const sort of ['name', 'size', 'length', 'date', 'opened', 'type']) {
    assert.deepEqual(names(q.buildPlaybackQueue([b, a], source({ sort, direction: 'asc' }))), ['a', 'b'], sort);
    assert.deepEqual(names(q.buildPlaybackQueue([a, b], source({ sort, direction: 'desc' }))), ['b', 'a'], sort);
  }
});
