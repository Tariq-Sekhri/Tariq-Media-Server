const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const { catalogTitleQueries, catalogTitleMatches, resolveCatalogTitle } = load('app/lib/catalog-title.ts');
const plain = value => JSON.parse(JSON.stringify(value));

test('anime release names keep both original and English titles without dangling quality tags', () => {
  assert.deepEqual(plain(catalogTitleQueries('[Group] Koe no Katachi (A Silent Voice) [BD 1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs].mkv')), [
    'Koe no Katachi (A Silent Voice)', 'Koe no Katachi', 'A Silent Voice',
  ]);
});

test('release years, groups, domains, punctuation and edition notes are cleaned', () => {
  assert.deepEqual(plain(catalogTitleQueries('[Group] www.example.org - Example.Movie (2016) [1080p].mkv')), ['Example Movie']);
  assert.deepEqual(plain(catalogTitleQueries('Example_Movie (Extended Edition) 1080p BluRay')), ['Example Movie']);
});

test('numbers belonging to actual titles are retained before considering a year fallback', () => {
  assert.equal(catalogTitleQueries('1917 (2019) [1080p]')[0], '1917');
  assert.equal(catalogTitleQueries('Blade.Runner.2049.1080p')[0], 'Blade Runner 2049');
  assert.equal(catalogTitleQueries('2001 A Space Odyssey (1968)')[0], '2001 A Space Odyssey');
});

test('release descriptions do not become standalone alternate title queries', () => {
  const queries = catalogTitleQueries('Example Title (Dual-Audio) (HEVC x265)');
  assert.deepEqual(plain(queries), ['Example Title']);
  assert.equal(catalogTitleMatches(queries, 'Dual Audio'), false);
});

test('lookup retries the embedded English title and accepts its canonical catalog suffix', async () => {
  const queries = catalogTitleQueries('[Group] Koe no Katachi (A Silent Voice) [BD 1080p].mkv');
  const calls = [];
  const movie = { id: 'tt5323662', name: 'A Silent Voice: The Movie', type: 'movie' };
  const found = await resolveCatalogTitle(queries, 'movie', async (title, kind) => {
    calls.push([title, kind]);
    return title === 'A Silent Voice' ? { status: 200, metadata: movie } : { status: 404 };
  });
  assert.equal(found.id, movie.id);
  assert.deepEqual(calls.map(([title]) => title), plain(queries));
  assert.ok(calls.every(([, kind]) => kind === 'movie'));
});

test('unrelated results and partial word overlaps never pass title validation', async () => {
  assert.equal(catalogTitleMatches(['Voice'], 'Voices of Tomorrow'), false);
  assert.equal(catalogTitleMatches(['Koe no Katachi', 'A Silent Voice'], 'The Voice of Sin'), false);
  await assert.rejects(resolveCatalogTitle(['Example Title'], 'movie', async () => ({ status: 200, metadata: { name: 'Another Film' } })), /No matching/);
});

test('service errors stop alias retries while missing empty folders can try the series catalog', async () => {
  let calls = 0;
  await assert.rejects(resolveCatalogTitle(['Original', 'English'], 'movie', async () => { calls++; return { status: 503 }; }), /503/);
  assert.equal(calls, 1);
  const found = await resolveCatalogTitle(['Example Show'], 'movie', async (_, kind) => kind === 'series'
    ? { status: 200, metadata: { name: 'Example Show', type: kind } } : { status: 404 }, true);
  assert.equal(found.type, 'series');
});
