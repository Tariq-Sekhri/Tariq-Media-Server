const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage, libraryPlayback } = require('./load-ts.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const media = load('app/lib/media.ts');
const search = load('app/lib/search.ts', {}, { './media': media });
const queue = load('app/lib/playback-queue.ts', {}, { './media': media, './search': search });
const filters = load('app/lib/browse-tag-filters.ts');
const source = { version: 1, section: 'library', folder: 'Library', search: '', globalSearch: false,
  tags: ['chosen', 'Favorites'], sort: 'name', direction: 'asc', method: 'item',
  returnUrl: '/?folder=Library', startedAt: 1000 };
const entry = path => ({ path, name: path.split('/').pop(), kind: 'file', size: 10, created_at: 1 });

test('URL-only reconstruction uses recursive inherited tags, favorites and numeric ordering', async () => {
  const params = new URLSearchParams();
  queue.writeQueueSource(params, source);
  const restored = queue.readQueueSource(new URLSearchParams(params.toString()));
  const entries = ['Library/Sub/track10.mp3', 'Library/Sub/track2.mp3', 'Library/Sub/skip.mp3',
    'Library/Other/no.mp3', 'Elsewhere/other.mp3'].map(entry);
  const calls = [];
  const result = await queue.loadPlaybackQueue(restored, async url => {
    calls.push(url);
    return Response.json(url === '/api/user-state'
      ? { tags: { Library: ['chosen'] }, favorites: ['Library/Sub/track10.mp3', 'Library/Sub/track2.mp3', 'Elsewhere/other.mp3'] }
      : entries);
  });
  assert.deepEqual(Array.from(result.queue, x => x.path), ['Library/Sub/track2.mp3', 'Library/Sub/track10.mp3']);
  assert.equal(new URL(calls.find(x => x.startsWith('/api/library')), 'http://example.test').searchParams.has('folder'), false);
  assert.equal(result.queue.every(x => x.tags.includes('chosen') && x.favorite), true);
});

test('filter inventory distinguishes a type that appears beyond the first page', () => {
  const first = Array.from({ length: 40 }, () => ({ tags: ['Audio', 'shared'] }));
  const complete = [...first, { tags: ['Video', 'shared'] }];
  assert.equal(filters.browseTagFilters(first, true).filters.includes('Video'), false);
  const inventory = filters.browseTagFilters(complete, true);
  assert.equal(inventory.filters.includes('Video'), true);
  assert.equal(inventory.filters.includes('Audio'), true);
  assert.equal(inventory.commonTags.has('shared'), true);
});

test('offline progress retry keeps each account isolated and never uploads fresh-start paths', async () => {
  const saved = storage();
  const playback = libraryPlayback({ fresh: { startFresh: true } }, { localStorage: storage() });
  const progress = load('app/lib/watch-progress.ts', { window: { localStorage: saved } }, { './library-playback': playback });
  const state = (position, updated) => ({ position, duration: 100, updated });
  progress.writeLocalWatchProgress(1, 'Library/a.mp4', state(30, 10));
  progress.writeLocalWatchProgress(2, 'Library/a.mp4', state(70, 20));
  progress.writeLocalWatchProgress(1, 'Fresh/a.mp3', state(80, 30));
  const local = progress.readLocalWatchProgress(1);
  await assert.rejects(progress.syncLocalWatchProgress({}, local, async () => { throw Error('offline'); }), /offline/);
  const uploads = [];
  await progress.syncLocalWatchProgress({}, progress.readLocalWatchProgress(1), async (path, value) => uploads.push([path, value.position]));
  assert.deepEqual(uploads, [['Library/a.mp4', 30]]);
  assert.equal(progress.readLocalWatchProgress(2)['Library/a.mp4'].position, 70);
  assert.equal(progress.mergeWatchProgress({ 'Fresh/a.mp3': state(90, 40) }, local)['Fresh/a.mp3'], undefined);
});

test('paged shuffle retries the first page only when the sampled page has no playable entries', async () => {
  const calls = [];
  let selected;
  const playable = { id: 'a', name: 'a', path: 'Library/a', parent: 'Library', kind: 'audio', src: '/media/a', tags: [] };
  await queue.startPagedShuffle(100, { ...source, method: 'shuffle' }, async offset => {
    calls.push(offset);
    return offset ? [{ ...playable, kind: 'folder' }] : [playable];
  }, (item, context) => { selected = [item.path, context.anchor]; }, () => 0.75);
  assert.deepEqual(calls, [75, 0]);
  assert.deepEqual(selected, ['Library/a', 'Library/a']);
  await assert.rejects(queue.startPagedShuffle(100, source, async () => [], () => assert.fail('must not navigate'), () => 0.75), /No playable/);
});

test('natural end waits for delayed queue and advances exactly once when it arrives', () => {
  const file = 'app/MiniAudioPlayer.tsx';
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let ended, effect;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handlePlaybackEnded') ended = node.initializer;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('endedWaitingRef.current')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(ended && effect);
  const compile = node => ts.transpileModule(`(${node.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const events = [];
  const context = vm.createContext({ activeAudio: () => ({}), checkpoint: (_, event) => events.push(event),
    loopEnabled: false, playbackPreferences: { auto_next_enabled: true }, nextItem: null, queueLoading: true,
    endedWaitingRef: { current: false }, playAfterLoadRef: { current: false }, setPlaying: value => events.push(value),
    changeItem: item => events.push(item.id), advanceLoadedQueue: () => events.push('next') });
  const onEnd = vm.runInContext(compile(ended), context);
  const onQueueChange = vm.runInContext(compile(effect), context);
  onEnd();
  onQueueChange();
  assert.deepEqual(events, ['completed', false]);
  context.nextItem = { id: 'next' };
  context.queueLoading = false;
  onQueueChange();
  onQueueChange();
  assert.deepEqual(events, ['completed', false, 'next']);
  assert.equal(context.playAfterLoadRef.current, true);
  assert.equal(context.endedWaitingRef.current, false);
});
