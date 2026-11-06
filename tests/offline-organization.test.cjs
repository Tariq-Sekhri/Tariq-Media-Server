const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { load, storage } = require('./load-ts.cjs');

// The module runs in its own realm; compare its results as plain JSON data.
const plain = (value) => value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
const organization = Object.fromEntries(Object.entries(load('app/lib/offline-organization.ts')).map(([name, value]) => [
  name,
  typeof value !== 'function' ? value : (...args) => {
    const result = value(...args);
    return typeof result?.then === 'function' ? result.then(plain) : plain(result);
  },
]));

// The organization endpoints as backend/src/main.rs implements them:
// organize replaces an item's tags and its membership in every playlist,
// unknown playlists or paths are 404, duplicate names are 409.
function server({ files = [], folders = [] } = {}) {
  const state = { tags: {}, tag_catalog: {}, playlists: {}, favorites: new Set() };
  const control = { state, reachable: true, failures: new Set(), requests: [] };
  let nextId = 1;
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
  const same = (left, right) => left.toLowerCase() === right.toLowerCase();
  const normalizeTags = (values) => {
    if (values.length > 20) return null;
    const tags = [];
    for (const value of values) {
      const tag = value.trim().replace(/^#+/, '').trim();
      if (!tag) continue;
      if ([...tag].length > 32) return null;
      if (!tags.some((existing) => same(existing, tag))) tags.push(tag);
    }
    return tags.sort();
  };
  control.request = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    control.requests.push(`${method} ${path}`);
    if (!control.reachable) throw new TypeError('Failed to fetch');
    if (control.failures.has(`${method} ${path}`)) return respond(503);
    const body = init.body ? JSON.parse(init.body) : {};
    const now = Math.floor(Date.now() / 1000);
    if (method === 'GET' && path === '/api/user-state') {
      return respond(200, {
        tags: state.tags, tag_catalog: state.tag_catalog, favorites: [...state.favorites],
        playlists: Object.fromEntries(Object.entries(state.playlists).map(([id, playlist]) => [id, { ...playlist, paths: [...playlist.paths] }])),
      });
    }
    if (method === 'POST' && path === '/api/playlists') {
      const name = organization.cleanPlaylistName(body.name);
      if (!name) return respond(400);
      if (Object.values(state.playlists).some((playlist) => same(playlist.name, name))) return respond(409);
      const playlist = { id: `server-${nextId++}`, name, paths: [], created_at: now, updated_at: now };
      state.playlists[playlist.id] = playlist;
      return respond(201, playlist);
    }
    if (method === 'DELETE' && path.startsWith('/api/playlists/')) {
      const id = decodeURIComponent(path.slice('/api/playlists/'.length));
      if (!state.playlists[id]) return respond(404);
      delete state.playlists[id];
      return respond(204);
    }
    if (method === 'POST' && path === '/api/tags') {
      const name = normalizeTags([body.name])?.[0];
      if (!name) return respond(400);
      if ([...Object.keys(state.tag_catalog), ...Object.values(state.tags).flat()].some((tag) => same(tag, name))) return respond(409);
      state.tag_catalog[name] = { name, created_at: now, updated_at: now };
      return respond(201, state.tag_catalog[name]);
    }
    if (method === 'DELETE' && path.startsWith('/api/tags/')) {
      const name = decodeURIComponent(path.slice('/api/tags/'.length));
      const catalogName = Object.keys(state.tag_catalog).find((tag) => same(tag, name));
      const assigned = Object.values(state.tags).some((tags) => tags.some((tag) => same(tag, name)));
      if (!catalogName && !assigned) return respond(404);
      if (catalogName) delete state.tag_catalog[catalogName];
      for (const [item, tags] of Object.entries(state.tags)) {
        const remaining = tags.filter((tag) => !same(tag, name));
        if (remaining.length) state.tags[item] = remaining;
        else delete state.tags[item];
      }
      return respond(204);
    }
    if (method === 'PUT' && path === '/api/organize') {
      const tags = normalizeTags(body.tags);
      if (!tags) return respond(400);
      const isFolder = folders.includes(body.path);
      if (!isFolder && !files.includes(body.path)) return respond(404);
      if (isFolder && body.playlist_ids.length) return respond(400);
      if (!body.playlist_ids.every((id) => state.playlists[id])) return respond(404);
      if (tags.length) {
        state.tags[body.path] = tags;
        tags.forEach((tag) => { state.tag_catalog[tag] ??= { name: tag, created_at: now, updated_at: now }; });
      } else delete state.tags[body.path];
      for (const playlist of Object.values(state.playlists)) {
        const include = body.playlist_ids.includes(playlist.id);
        if (include && !playlist.paths.includes(body.path)) playlist.paths.push(body.path);
        if (!include) playlist.paths = playlist.paths.filter((item) => item !== body.path);
      }
      return respond(204);
    }
    if (method === 'PUT' && path === '/api/favorites') {
      if (!body.path.trim()) return respond(400);
      if (body.favorite) state.favorites.add(body.path);
      else state.favorites.delete(body.path);
      return respond(204);
    }
    return respond(404);
  };
  control.playlistNamed = (name) => Object.values(state.playlists).find((playlist) => playlist.name === name);
  control.addPlaylist = (name, paths = []) => {
    const playlist = { id: `server-${nextId++}`, name, paths: [...paths], created_at: 1, updated_at: 1 };
    state.playlists[playlist.id] = playlist;
    return playlist;
  };
  return control;
}

const SONG = 'Music/Album/song.mp3';
const OTHER = 'Music/Album/other.mp3';
const ALBUM = 'Music/Album';
const T = 1_700_000_000_000;

const sync = async (pending, backend) => {
  const result = await organization.syncPendingChanges(pending, backend.request);
  return { result, remaining: organization.finishPendingSync(pending, result) };
};

test('offline tag and playlist edits show in the organization state, and replaying them again changes nothing', () => {
  const saved = {
    tags: { [OTHER]: ['Old'] },
    tag_catalog: { Old: { name: 'Old', created_at: 1 } },
    playlists: { mix: { id: 'mix', name: 'Mix', paths: [OTHER], created_at: 1 } },
  };
  let pending = organization.emptyPendingChanges();
  pending = organization.withPlaylistCreated(pending, 'offline-playlist-road', 'Road trip', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: ['Chill', 'Summer'], playlist_ids: ['mix', 'offline-playlist-road'], updatedAt: T + 1 });
  pending = organization.withOrganization(pending, { path: OTHER, tags: [], playlist_ids: [], updatedAt: T + 2 });
  pending = organization.withTagCreated(pending, 'Later', T + 3);

  const shown = organization.applyPendingOrganization(saved, pending);
  assert.deepEqual(shown.tags, { [SONG]: ['Chill', 'Summer'] });
  assert.deepEqual(shown.playlists.mix.paths, [SONG]);
  assert.deepEqual(shown.playlists['offline-playlist-road'].paths, [SONG]);
  assert.equal(shown.playlists['offline-playlist-road'].name, 'Road trip');
  assert.ok(shown.tag_catalog.Chill && shown.tag_catalog.Summer && shown.tag_catalog.Later && shown.tag_catalog.Old);
  assert.deepEqual(organization.applyPendingOrganization(shown, pending), shown, 'replay is idempotent');
  assert.deepEqual(saved.playlists.mix.paths, [OTHER], 'the saved state is not mutated');
});

test('a tag edit made offline is saved on the server and leaves the queue', async () => {
  const backend = server({ files: [SONG] });
  const pending = organization.withOrganization(organization.emptyPendingChanges(), { path: SONG, tags: ['Chill'], playlist_ids: [], updatedAt: T });
  const { result, remaining } = await sync(pending, backend);
  assert.equal(result.organizationSynced, 1);
  assert.deepEqual(backend.state.tags, { [SONG]: ['Chill'] });
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('a playlist created offline is created on the server and receives its items under the server id', async () => {
  const backend = server({ files: [SONG, OTHER] });
  let pending = organization.withPlaylistCreated(organization.emptyPendingChanges(), 'offline-playlist-a', 'Road trip', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: ['Drive'], playlist_ids: ['offline-playlist-a'], updatedAt: T + 1 });
  pending = organization.withOrganization(pending, { path: OTHER, tags: [], playlist_ids: ['offline-playlist-a'], updatedAt: T + 2 });
  const { result, remaining } = await sync(pending, backend);
  const created = backend.playlistNamed('Road trip');
  assert.ok(created, 'the playlist exists on the server');
  assert.deepEqual(created.paths.sort(), [OTHER, SONG].sort());
  assert.equal(result.playlistIds['offline-playlist-a'], created.id);
  assert.deepEqual(backend.state.tags[SONG], ['Drive']);
  assert.equal(organization.hasPendingChanges(remaining), false);
  assert.deepEqual(backend.requests.slice(0, 1), ['POST /api/playlists'], 'the playlist is created before items are added');
});

test('creating an offline playlist whose name now exists on the server reuses that playlist', async () => {
  const backend = server({ files: [SONG] });
  const existing = backend.addPlaylist('Road Trip');
  let pending = organization.withPlaylistCreated(organization.emptyPendingChanges(), 'offline-playlist-a', 'road trip', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: [], playlist_ids: ['offline-playlist-a'], updatedAt: T + 1 });
  const { remaining } = await sync(pending, backend);
  assert.equal(Object.keys(backend.state.playlists).length, 1);
  assert.deepEqual(backend.state.playlists[existing.id].paths, [SONG]);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('deleting a playlist offline deletes it on the server and removes it from queued item changes', async () => {
  const backend = server({ files: [SONG] });
  const mix = backend.addPlaylist('Mix', [SONG]);
  let pending = organization.withOrganization(organization.emptyPendingChanges(), { path: SONG, tags: ['Chill'], playlist_ids: [mix.id], updatedAt: T });
  pending = organization.withPlaylistDeleted(pending, mix.id, T + 1);
  assert.deepEqual(pending.organization[0].playlist_ids, []);
  assert.equal(organization.applyPendingOrganization({ playlists: backend.state.playlists }, pending).playlists[mix.id], undefined);
  const { remaining } = await sync(pending, backend);
  assert.equal(backend.state.playlists[mix.id], undefined);
  assert.deepEqual(backend.state.tags[SONG], ['Chill']);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('deleting a playlist that was created offline withdraws it without contacting the server', async () => {
  const backend = server({ files: [SONG] });
  let pending = organization.withPlaylistCreated(organization.emptyPendingChanges(), 'offline-playlist-a', 'Temp', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: ['Keep'], playlist_ids: ['offline-playlist-a'], updatedAt: T + 1 });
  pending = organization.withPlaylistDeleted(pending, 'offline-playlist-a', T + 2);
  assert.deepEqual(pending.catalog, []);
  await sync(pending, backend);
  assert.deepEqual(Object.keys(backend.state.playlists), []);
  assert.ok(!backend.requests.some((request) => request.includes('/api/playlists')));
  assert.deepEqual(backend.state.tags[SONG], ['Keep']);
});

test('tags created and deleted offline are applied on the server after item changes', async () => {
  const backend = server({ files: [SONG, OTHER] });
  backend.state.tags[OTHER] = ['Old'];
  backend.state.tag_catalog.Old = { name: 'Old', created_at: 1 };
  let pending = organization.withTagCreated(organization.emptyPendingChanges(), 'Fresh', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: ['Old', 'Fresh'], playlist_ids: [], updatedAt: T + 1 });
  pending = organization.withTagDeleted(pending, 'old', T + 2);
  assert.deepEqual(pending.organization[0].tags, ['Fresh'], 'the deleted tag leaves queued item changes');
  const shown = organization.applyPendingOrganization(structuredClone(backend.state), pending);
  assert.equal(shown.tag_catalog.Old, undefined);
  assert.equal(shown.tags[OTHER], undefined);
  const { remaining } = await sync(pending, backend);
  assert.equal(backend.state.tag_catalog.Old, undefined);
  assert.equal(backend.state.tags[OTHER], undefined);
  assert.deepEqual(backend.state.tags[SONG], ['Fresh']);
  assert.ok(backend.state.tag_catalog.Fresh);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('using a tag again after deleting it offline keeps the tag', async () => {
  let pending = organization.withTagDeleted(organization.emptyPendingChanges(), 'Chill', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: ['chill'], playlist_ids: [], updatedAt: T + 1 });
  assert.deepEqual(pending.catalog, []);
  pending = organization.withTagDeleted(pending, 'Chill', T + 2);
  pending = organization.withTagCreated(pending, 'Chill', T + 3);
  assert.deepEqual(pending.catalog.map((change) => change.type), ['create_tag']);
});

test('folder tags made offline sync without playlists', async () => {
  const backend = server({ folders: [ALBUM] });
  const pending = organization.withOrganization(organization.emptyPendingChanges(), { path: ALBUM, tags: ['Jazz'], playlist_ids: [], updatedAt: T });
  const { remaining } = await sync(pending, backend);
  assert.deepEqual(backend.state.tags[ALBUM], ['Jazz']);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('favorites made offline sync with the rest of the queue', async () => {
  const backend = server({ files: [SONG] });
  const pending = organization.withFavorite(organization.emptyPendingChanges(), { path: SONG, favorite: true, updatedAt: T });
  const { result, remaining } = await sync(pending, backend);
  assert.equal(result.favoritesSynced, 1);
  assert.ok(backend.state.favorites.has(SONG));
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('an unreachable server keeps every queued change for the next sync', async () => {
  const backend = server({ files: [SONG] });
  backend.reachable = false;
  let pending = organization.withPlaylistCreated(organization.emptyPendingChanges(), 'offline-playlist-a', 'Later', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: ['A'], playlist_ids: ['offline-playlist-a'], updatedAt: T + 1 });
  pending = organization.withTagDeleted(pending, 'Gone', T + 2);
  pending = organization.withFavorite(pending, { path: SONG, favorite: true, updatedAt: T + 3 });
  const { remaining } = await sync(pending, backend);
  assert.deepEqual(remaining, pending);
  backend.reachable = true;
  const second = await sync(remaining, backend);
  assert.equal(organization.hasPendingChanges(second.remaining), false);
  assert.deepEqual(backend.playlistNamed('Later').paths, [SONG]);
});

test('items wait for a playlist whose creation failed, and keep the server id when only the item fails', async () => {
  const backend = server({ files: [SONG] });
  backend.failures.add('POST /api/playlists');
  let pending = organization.withPlaylistCreated(organization.emptyPendingChanges(), 'offline-playlist-a', 'Mix', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: [], playlist_ids: ['offline-playlist-a'], updatedAt: T + 1 });
  let { remaining } = await sync(pending, backend);
  assert.ok(!backend.requests.includes('PUT /api/organize'), 'the item is not saved without its playlist');
  assert.deepEqual(remaining, pending);

  backend.failures.clear();
  backend.failures.add('PUT /api/organize');
  ({ remaining } = await sync(remaining, backend));
  const created = backend.playlistNamed('Mix');
  assert.deepEqual(remaining.catalog, []);
  assert.deepEqual(remaining.organization[0].playlist_ids, [created.id], 'the retry refers to the playlist that now exists');

  backend.failures.clear();
  ({ remaining } = await sync(remaining, backend));
  assert.deepEqual(created.paths, [SONG]);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('a playlist deleted on the server meanwhile does not block the item tags', async () => {
  const backend = server({ files: [SONG] });
  const pending = organization.withOrganization(organization.emptyPendingChanges(), { path: SONG, tags: ['Chill'], playlist_ids: ['server-removed'], updatedAt: T });
  const { remaining } = await sync(pending, backend);
  assert.deepEqual(backend.state.tags[SONG], ['Chill']);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('changes the server can never accept are dropped instead of retried forever', async () => {
  const backend = server({ files: [] });
  let pending = organization.withOrganization(organization.emptyPendingChanges(), { path: 'Music/deleted.mp3', tags: ['A'], playlist_ids: [], updatedAt: T });
  pending = organization.withPlaylistDeleted(pending, 'server-already-gone', T + 1);
  pending = organization.withTagDeleted(pending, 'never-existed', T + 2);
  const { result, remaining } = await sync(pending, backend);
  assert.equal(result.organizationSynced, 0);
  assert.equal(organization.hasPendingChanges(remaining), false);
});

test('changes queued while a sync runs are kept and refer to new server ids', async () => {
  const backend = server({ files: [SONG, OTHER] });
  let pending = organization.withPlaylistCreated(organization.emptyPendingChanges(), 'offline-playlist-a', 'Mix', T);
  pending = organization.withOrganization(pending, { path: SONG, tags: [], playlist_ids: ['offline-playlist-a'], updatedAt: T + 1 });
  const result = await organization.syncPendingChanges(pending, backend.request);
  // The user added another item to the playlist before the sync finished.
  const during = organization.withOrganization(pending, { path: OTHER, tags: [], playlist_ids: ['offline-playlist-a'], updatedAt: T + 2 });
  const remaining = organization.finishPendingSync(during, result);
  const created = backend.playlistNamed('Mix');
  assert.deepEqual(remaining.catalog, []);
  assert.deepEqual(remaining.organization, [{ path: OTHER, tags: [], playlist_ids: [created.id], updatedAt: T + 2 }]);
  await sync(remaining, backend);
  assert.deepEqual(created.paths.sort(), [OTHER, SONG].sort());
});

test('offline names follow the server rules', () => {
  assert.equal(organization.cleanTagName('  #Chill '), 'Chill');
  assert.equal(organization.cleanTagName('x'.repeat(33)), null);
  assert.equal(organization.cleanTagName('#'), null);
  assert.equal(organization.cleanPlaylistName(' Road trip '), 'Road trip');
  assert.equal(organization.cleanPlaylistName('a/b'), null);
  assert.equal(organization.cleanPlaylistName('..'), null);
  assert.equal(organization.cleanPlaylistName('x'.repeat(81)), null);
});

// offline.ts stores the queue in the page's localStorage and, on Android, in
// the device store shared by the offline shell and the connected app.
function nativeStore({ storesCatalog = true } = {}) {
  const saved = { organization: '[]', favorites: '[]', catalog: '[]' };
  return {
    saved,
    getPendingOfflineChanges: async () => ({
      organization: JSON.parse(saved.organization), favorites: JSON.parse(saved.favorites),
      ...(storesCatalog ? { catalog: JSON.parse(saved.catalog) } : {}),
    }),
    replacePendingOfflineChanges: async ({ organization: items, favorites, catalog }) => {
      saved.organization = JSON.stringify(items);
      saved.favorites = JSON.stringify(favorites);
      if (storesCatalog) saved.catalog = JSON.stringify(catalog);
    },
    getOfflineUserState: async () => ({}),
  };
}

function page({ native, localStorage = storage(), backend }) {
  return load('app/lib/offline.ts', { localStorage, crypto: webcrypto, indexedDB: {}, window: {} }, {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => Boolean(native) }, registerPlugin: () => native ?? {} },
    './auth': { getSessionUser: () => ({ id: 7, name: 'Tariq' }), authFetch: (path, init) => backend.request(path, init) },
    './offline-organization': organization,
  });
}

test('Android: tags and playlists changed in the offline shell sync from the connected app', async () => {
  const native = nativeStore();
  const backend = server({ files: [SONG, OTHER] });
  const mix = backend.addPlaylist('Mix', [OTHER]);
  backend.state.tag_catalog.Old = { name: 'Old', created_at: 1 };
  const shell = page({ native, backend });
  const playlist = shell.queueOfflinePlaylistCreate('Road trip', ['Mix']);
  shell.queueOfflineOrganization(SONG, ['Drive'], [playlist.id, mix.id]);
  shell.queueOfflinePlaylistDelete(mix.id);
  shell.queueOfflineTagCreate('Night', ['Old']);
  shell.queueOfflineTagDelete('Old');
  shell.queueOfflineFavorite(SONG, true);
  await shell.hydratePendingOfflineChanges();
  assert.throws(() => shell.queueOfflinePlaylistCreate('road TRIP', ['Road trip']), /already exists/);

  // The connected app is another origin with its own, empty localStorage.
  const connected = page({ native, backend });
  const result = await connected.syncPendingOfflineOrganization();
  assert.equal(result.remaining, 0);
  assert.equal(result.favoritesRemaining, 0);
  const created = backend.playlistNamed('Road trip');
  assert.deepEqual(created.paths, [SONG]);
  assert.equal(result.playlistIds[playlist.id], created.id);
  assert.equal(backend.state.playlists[mix.id], undefined);
  assert.deepEqual(backend.state.tags[SONG], ['Drive']);
  assert.ok(backend.state.tag_catalog.Night);
  assert.equal(backend.state.tag_catalog.Old, undefined);
  assert.ok(backend.state.favorites.has(SONG));
  assert.deepEqual(JSON.parse(native.saved.organization), []);
  assert.deepEqual(JSON.parse(native.saved.catalog), []);

  // Opening the offline shell again must not replay the synced changes.
  await shell.hydratePendingOfflineChanges();
  assert.equal(organization.hasPendingChanges(shell.readPendingOfflineChanges()), false);
});

test('Android: a change in the connected app does not discard changes queued in the offline shell', async () => {
  const native = nativeStore();
  const backend = server({ files: [SONG, OTHER] });
  const shell = page({ native, backend });
  const playlist = shell.queueOfflinePlaylistCreate('Mix');
  shell.queueOfflineOrganization(SONG, ['A'], [playlist.id]);
  await shell.hydratePendingOfflineChanges();
  // The connected app has not read the device queue yet when this is queued.
  backend.reachable = false;
  const connected = page({ native, backend });
  connected.queueOfflineFavorite(OTHER, true);
  await connected.hydratePendingOfflineChanges();
  assert.equal(JSON.parse(native.saved.catalog).length, 1);
  assert.equal(JSON.parse(native.saved.organization).length, 1);
  assert.equal(JSON.parse(native.saved.favorites).length, 1);
  backend.reachable = true;
  await connected.syncPendingOfflineOrganization();
  assert.deepEqual(backend.playlistNamed('Mix').paths, [SONG]);
  assert.ok(backend.state.favorites.has(OTHER));
});

test('Android: a failed sync keeps changes on the device for the next attempt', async () => {
  const native = nativeStore();
  const backend = server({ files: [SONG] });
  const shell = page({ native, backend });
  const playlist = shell.queueOfflinePlaylistCreate('Mix');
  shell.queueOfflineOrganization(SONG, ['A'], [playlist.id]);
  await shell.hydratePendingOfflineChanges();
  backend.reachable = false;
  const connected = page({ native, backend });
  const failed = await connected.syncPendingOfflineOrganization();
  assert.equal(failed.remaining, 2);
  assert.equal(JSON.parse(native.saved.organization).length, 1);
  backend.reachable = true;
  const retried = await page({ native, backend }).syncPendingOfflineOrganization();
  assert.equal(retried.remaining, 0);
  assert.deepEqual(backend.playlistNamed('Mix').paths, [SONG]);
});

test('Android: an older app build without catalog storage keeps playlist changes in the page', async () => {
  const native = nativeStore({ storesCatalog: false });
  const backend = server({ files: [SONG] });
  const localStorage = storage();
  const app = page({ native, backend, localStorage });
  const playlist = app.queueOfflinePlaylistCreate('Mix');
  app.queueOfflineOrganization(SONG, [], [playlist.id]);
  await app.hydratePendingOfflineChanges();
  assert.equal(app.readPendingOfflineChanges().catalog.length, 1, 'hydrating does not discard the page copy');
  const result = await app.syncPendingOfflineOrganization();
  assert.equal(result.remaining, 0);
  assert.deepEqual(backend.playlistNamed('Mix').paths, [SONG]);
});

test('browser: the queue survives a reload and syncs when the server returns', async () => {
  const backend = server({ files: [SONG] });
  const localStorage = storage();
  const before = page({ backend, localStorage });
  const playlist = before.queueOfflinePlaylistCreate('Mix');
  before.queueOfflineOrganization(SONG, ['A'], [playlist.id]);
  const reloaded = page({ backend, localStorage });
  const shown = organization.applyPendingOrganization({}, reloaded.readPendingOfflineChanges());
  assert.deepEqual(shown.playlists[playlist.id].paths, [SONG]);
  assert.deepEqual(shown.tags[SONG], ['A']);
  const result = await reloaded.syncPendingOfflineOrganization();
  assert.equal(result.synced, 1);
  assert.equal(result.catalogSynced, 1);
  assert.equal(localStorage.getItem('tms:offline-organization:v1'), null);
  assert.equal(localStorage.getItem('tms:offline-catalog:v1'), null);
});
