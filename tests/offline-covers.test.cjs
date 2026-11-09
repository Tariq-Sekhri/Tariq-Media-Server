const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const media = load('app/lib/media.ts');
const { offlineFolderCovers } = load('app/lib/offline-covers.ts', {}, { './media': media });

test('downloads root and nested artwork without including unrelated library folders', () => {
  const files = [{ path: 'Library/Show/Season 1/episode.mp4' }, { path: 'Other/movie.mp4' }];
  const covers = offlineFolderCovers('Library/Show', files, path => `/covers/${encodeURIComponent(path)}.jpg`, 'https://server.test');
  assert.deepEqual(Object.keys(covers), ['Library/Show', 'Library/Show/Season 1']);
  assert.equal(covers['Library/Show'].public, false);
  assert.equal(covers['Library/Show'].url, 'https://server.test/covers/Library%2FShow.jpg');
});

test('catalog posters are saved as local artwork without sending server credentials to their host', () => {
  const covers = offlineFolderCovers('Library/Movie', [], () => 'https://posters.test/movie.jpg', 'https://server.test');
  assert.equal(covers['Library/Movie'].kind, 'image');
  assert.equal(covers['Library/Movie'].public, true);
  assert.match(covers['Library/Movie'].relativePath, /^\.tms-folder-cover-/);
});

test('unresolved folders and temporary blob artwork are not saved as broken cover URLs', () => {
  assert.equal(Object.keys(offlineFolderCovers('Library/Folder', [], () => undefined, 'https://server.test')).length, 0);
  assert.equal(Object.keys(offlineFolderCovers('Library/Folder', [], () => 'blob:temporary', 'https://server.test')).length, 0);
});
