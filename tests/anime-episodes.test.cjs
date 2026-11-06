const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const { episodeNumbers, mediaEvidenceForFolder } = load('app/lib/media.ts');

test('fansub episode numbers identify the anime in a paged library', () => {
  const path = 'Movies/The Fable S01 1080p WEBRip AAC x265-EMBER';
  const previewPath = `${path}/[EMBER] The Fable - 01.mkv`;
  assert.equal(episodeNumbers(previewPath).episode, 1);
  assert.equal(episodeNumbers(previewPath).season, 1);
  assert.equal(episodeNumbers('Movies/Show/Season 2/[Group] Show - 12 [1080p].mkv').season, 2);
  assert.equal(mediaEvidenceForFolder([{ kind: 'folder', path, previewKind: 'video', previewPath }], path).kind, 'series');
});

test('movie years and video quality do not become anime episode numbers', () => {
  for (const name of ['The Fable - 2019.mkv', 'Movie - 1080p.mkv', 'Movie - 01 Trailer.mkv', 'Movie - 00.mkv']) {
    assert.equal(episodeNumbers(name), null, name);
  }
});
