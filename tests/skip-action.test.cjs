const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./load-ts.cjs');
const { endingSkipAdvancesEpisode } = load('app/lib/skip-action.ts');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the player's actual click handler, including completion and the
// fallback when the queue has no next episode.
const page = fs.readFileSync('app/watch/page.tsx', 'utf8');
const handler = page.slice(page.indexOf('  const skipSegment ='), page.indexOf('  const seekPreviewUrl ='));
function clickSkip(kind, overrides = {}) {
  const calls = [];
  const context = {
    details: { imdbId: 'tt2098220', folder: 'TV/Hunter x Hunter' },
    nextQueueItem: { name: 'Episode 6' },
    backgroundAudioRef: { current: null }, videoRef: { current: {} },
    isShowWatch: () => true, endingSkipAdvancesEpisode,
    saveProgress: (_, completed) => calls.push(['saved', completed]),
    reportPlayback: (event) => calls.push(['activity', event]),
    goToQueueItem: (item, completed) => calls.push(['next', item.name, completed]),
    seekTo: (time) => calls.push(['seek', time]),
    ...overrides,
  };
  vm.runInNewContext(ts.transpileModule(handler + '\nskipSegment({kind: ' + JSON.stringify(kind) + ', end: 1400});', {}).outputText, context);
  return calls;
}

test('clicking the ending skip completes the current episode and starts the queued next episode', () => {
  assert.deepEqual(clickSkip('credits'), [['saved', true], ['activity', 'completed'], ['next', 'Episode 6', true]]);
  assert.deepEqual(clickSkip('preview'), [['saved', true], ['activity', 'completed'], ['next', 'Episode 6', true]]);
});

test('opening skips, other shows, movies, and the finale keep normal segment seeking', () => {
  assert.deepEqual(clickSkip('intro'), [['seek', 1400]]);
  assert.deepEqual(clickSkip('credits', { nextQueueItem: null }), [['seek', 1400]]);
  assert.deepEqual(clickSkip('credits', { isShowWatch: () => false }), [['seek', 1400]]);
  assert.deepEqual(clickSkip('credits', { details: { folder: 'TV/Another Show' } }), [['seek', 1400]]);
});

test('Hunter x Hunter ending skips advance, while opening and recap skips stay in the episode', () => {
  const show = { imdbId: 'tt2098220', folder: 'TV/Season 1' };
  assert.equal(endingSkipAdvancesEpisode(show, 'credits'), true);
  assert.equal(endingSkipAdvancesEpisode(show, 'preview'), true);
  assert.equal(endingSkipAdvancesEpisode(show, 'intro'), false);
  assert.equal(endingSkipAdvancesEpisode(show, 'recap'), false);
});

test('series identity works before metadata loads and does not match other shows', () => {
  for (const series of ['TV/Hunter x Hunter', 'TV/Hunter × Hunter (2011)', 'TV\\Hunter X Hunter\\']) {
    assert.equal(endingSkipAdvancesEpisode({ series, folder: 'TV/Season 1' }, 'credits'), true);
  }
  assert.equal(endingSkipAdvancesEpisode({ folder: 'TV/Hunter x Hunter' }, 'credits'), true);
  assert.equal(endingSkipAdvancesEpisode({ series: 'TV/Hunter x Hunter Extras', folder: '' }, 'credits'), false);
  assert.equal(endingSkipAdvancesEpisode({ imdbId: 'tt1234567', series: 'TV/Hunter x Hunter', folder: '' }, 'credits'), false);
  assert.equal(endingSkipAdvancesEpisode({ series: 'TV/Another Show', folder: '' }, 'credits'), false);
  assert.equal(endingSkipAdvancesEpisode({ imdbId: 'tt3198698', folder: 'TV/[Judas] Hunter x Hunter (2011) (Complete Series + Movies) [BD 1080p]/[Judas] Hunter x Hunter (2011) - Episodes 001-148' }, 'credits'), true);
  assert.equal(endingSkipAdvancesEpisode({ folder: 'TV/Hunter x Hunter (1999)' }, 'credits'), false);
});
