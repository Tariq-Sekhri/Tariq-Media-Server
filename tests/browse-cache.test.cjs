const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage } = require('./load-ts.cjs');

const imports = () => ({ './media': load('app/lib/media.ts') });

test('scroll persistence does not rewrite the large snapshot and survives reload', () => {
  const sessionStorage = storage();
  const globals = { sessionStorage, window: {} };
  const cache = load('app/lib/browse-cache.ts', globals, imports());
  cache.saveBrowseSnapshot({ url: '/?folder=Movies', items: Array(1000).fill({ path: 'Movies/item' }), scrollY: 0 });
  const original = sessionStorage.getItem(cache.BROWSE_SNAPSHOT_KEY);
  cache.updateSnapshotScroll(900);
  assert.equal(sessionStorage.getItem(cache.BROWSE_SNAPSHOT_KEY), original);
  const reloaded = load('app/lib/browse-cache.ts', globals, imports());
  assert.equal(reloaded.readBrowseSnapshot('/?folder=Movies').scrollY, 900);
  reloaded.saveBrowseSnapshot({ url: '/?folder=Other', items: [], scrollY: 0 });
  assert.equal(load('app/lib/browse-cache.ts', globals, imports()).readBrowseSnapshot('/?folder=Other').scrollY, 0);
});

test('finished scroll restoration removes capture listeners and settles only once', () => {
  const listeners = new Map();
  let settled = 0;
  const window = {
    innerHeight: 600, scrollY: 0,
    scrollTo: (_, y) => { window.scrollY = y; },
    addEventListener: (name, fn, options) => listeners.set(`${name}:${options.capture}`, fn),
    removeEventListener: (name, fn, capture) => listeners.delete(`${name}:${Boolean(capture)}`),
    clearTimeout, cancelAnimationFrame() {},
  };
  const cache = load('app/lib/browse-cache.ts', { window, document: { documentElement: { scrollHeight: 3000 } } }, imports());
  const cleanup = cache.restoreBrowseScroll(900, () => settled++);
  assert.equal(listeners.size, 0);
  cleanup();
  assert.equal(settled, 1);
});

test('items inherit tags from every ancestor folder', () => {
  const media = load('app/lib/media.ts');
  const tags = { Music: ['audio-lib'], 'Music/Rock': ['rock'], 'Music/Rock/song.mp3': ['fav'], 'Music/Rockabilly': ['other'] };
  assert.deepEqual([...media.inheritedTags('Music/Rock/song.mp3', tags)].sort(), ['audio-lib', 'fav', 'rock']);
  assert.deepEqual([...media.inheritedTags('Music/Rock/new.mp3', tags)].sort(), ['audio-lib', 'rock']);
  assert.deepEqual([...media.ancestorTags('Music/Rock', tags)], ['audio-lib']);
  assert.deepEqual([...media.inheritedTags('Videos/clip.mp4', tags)], []);
});

test('tagging a folder updates descendants in the browse snapshot', () => {
  const globals = { sessionStorage: storage(), window: {} };
  const cache = load('app/lib/browse-cache.ts', globals, imports());
  cache.saveBrowseSnapshot({
    url: '/?folder=Music',
    items: [
      { path: 'Music/Rock/song.mp3', kind: 'audio', tags: ['Audio'] },
      { path: 'Music/Rockabilly/song.mp3', kind: 'audio', tags: ['Audio'] },
    ],
    scrollY: 0,
  });
  cache.updateSnapshotOrganization('Music/Rock', { tags: { 'Music/Rock': ['rock'] }, tagCatalog: {}, playlists: {} });
  const [inside, outside] = cache.readBrowseSnapshot('/?folder=Music').items;
  assert.deepEqual([...inside.tags], ['Audio', 'rock']);
  assert.deepEqual([...outside.tags], ['Audio']);
});
