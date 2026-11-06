const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const media = load('app/lib/media.ts');
const search = load('app/lib/search.ts', {}, { './media': media });
const { buildSearchSuggestions, canSuggestLibraryPath } = load('app/lib/search-suggestions.ts', {}, { './media': media, './search': search });
const user = { name: 'Member', is_admin: false };
const libraries = {
  Shared: { members: [{ name: 'mEmBeR', can_view: true }] },
  Secret: { members: [{ name: 'Member', can_view: false }] },
  Others: { members: [{ name: 'Another', can_view: true }] },
};
const item = (path, tags = [], extra = {}) => ({ id: path, path, name: path.split('/').at(-1), parent: path.split('/').slice(0, -1).join('/'), kind: 'video', tags, ...extra });
const allowed = item('Shared/Allowed title.mp4', ['public-tag', 'common']);
const denied = item('Secret/Hidden title.mp4', ['secret-tag', 'common']);
const items = [allowed, denied, item('Others/Other title.mp4', ['other-tag']), item('Missing/Gone title.mp4', ['gone-tag']), item('Secret/Offline title.mp4', ['offline-tag'], { offline: { bundleId: 'saved' }, parent: 'offline:saved' })];
const suggest = (query = '', overrides = {}) => buildSearchSuggestions({ query, items, libraries, user, previousSearches: ['Hidden title', '!in:Secret / type:video', 'title:"Allowed title" / title:"Hidden title"', 'in:Shared "Allowed title"', 'type:video'], recentFolders: ['Secret/Hidden folder', 'Shared/Allowed folder', 'Missing/Gone folder'], ...overrides });

test('every suggestion channel excludes inaccessible fresh, cached and offline content', () => {
  for (const query of ['', 'in:', 'title:', 'tag:', '#', 'title', 'Hidden', 'is:trashed ']) {
    const output = JSON.stringify(suggest(query));
    for (const secret of ['Secret', 'Hidden', 'Others', 'Other title', 'Missing', 'Gone title', 'secret-tag', 'other-tag', 'gone-tag', 'offline-tag', 'Offline title']) assert.ok(!output.includes(secret), `${query} disclosed ${secret}`);
  }
  assert.deepEqual(Array.from(suggest('in:').map((value) => value.value)), ['Shared']);
  assert.equal(suggest('').find((value) => value.label === 'common').detail, 'Popular tag - 1 items');
  assert.ok(suggest('').some((value) => value.label === 'Shared/Allowed folder'.split('/').at(-1)));
  assert.ok(suggest('').some((value) => value.label === 'in:Shared "Allowed title"'));
});

test('revocation, absent permissions, missing user and inconsistent cached paths fail closed', () => {
  const revoked = { ...libraries, Shared: { members: [{ name: 'Member', can_view: false }] } };
  for (const query of ['in:', 'title:', 'tag:', '#', 'Allowed', '']) {
    assert.ok(!JSON.stringify(suggest(query, { libraries: revoked })).includes('Allowed'));
    assert.ok(!JSON.stringify(suggest(query, { libraries: {} })).includes('Allowed'));
    assert.ok(!JSON.stringify(suggest(query, { user: null })).includes('Allowed'));
  }
  assert.equal(canSuggestLibraryPath('Shared\\folder', libraries, user), true);
  assert.equal(canSuggestLibraryPath('Shared/../Secret', libraries, user), false);
  assert.equal(canSuggestLibraryPath('/Shared', libraries, user), false);
  assert.equal(canSuggestLibraryPath('Shared', { Shared: { members: [{ name: 'MÉMBER', can_view: true }] } }, { name: 'mémber', is_admin: false }), false);
  assert.ok(!JSON.stringify(suggest('title:', { items: [item('Shared/file.mp4', [], { parent: 'Secret/Hidden folder', name: 'Hidden title' })] })).includes('Hidden'));
});

test('administrators retain suggestions, and offline browse metadata stays out of shared suggestions', () => {
  assert.ok(suggest('title:', { user: { name: 'Admin', is_admin: true } }).some((value) => value.label === 'Hidden title.mp4'));
  assert.ok(!suggest('title:', { user: { name: 'Admin', is_admin: true } }).some((value) => value.label === 'Gone title.mp4'));
  const offline = item('Shared/Offline allowed.mp4', ['public-tag'], { offline: { bundleId: 'saved' }, parent: 'offline:saved' });
  const result = suggest('Offline', { items: [offline] }).find((value) => value.kind === 'media');
  assert.equal(result, undefined);
  assert.equal(offline.parent, 'offline:saved');
  assert.equal(offline.offline.bundleId, 'saved');
  assert.ok(suggest('type:').some((value) => value.value === 'video'));
});

test('a denied download remapped to an allowed path by basename cannot disclose tags or file identity', () => {
  const { buildOfflineAllMediaItems } = load('app/lib/offline-browse.ts', {}, { './media': media });
  const offline = buildOfflineAllMediaItems({
    bundles: [{ id: 'denied-bundle', name: 'Secret', path: 'Secret', createdAt: 1, files: [{ id: 'denied-file', path: 'Secret/same.mp4', name: 'same.mp4', relativePath: 'same.mp4', kind: 'video', size: 1 }] }],
    customTags: {}, favoritePaths: [],
    libraryByPath: new Map([
      ['Secret/same.mp4', item('Secret/same.mp4', ['secret-tag'])],
      ['Shared/same.mp4', item('Shared/same.mp4', ['public-tag'])],
    ]),
  });
  // Reproduce the existing metadata recovery behavior through the real builder.
  assert.equal(offline[0].path, 'Shared/same.mp4');
  assert.ok(offline[0].tags.includes('secret-tag'));
  for (const query of ['', 'tag:', '#', 'same', 'title:', 'tag:secret-tag']) {
    const output = JSON.stringify(suggest(query, { items: offline }));
    for (const secret of ['secret-tag', 'denied-bundle', 'denied-file']) assert.ok(!output.includes(secret), `${query} disclosed ${secret}`);
  }
});
