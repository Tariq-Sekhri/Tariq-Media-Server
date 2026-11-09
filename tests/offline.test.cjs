const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage } = require('./load-ts.cjs');

const organization = load('app/lib/offline-organization.ts');

// Request success precedes transaction completion. Writes become visible only
// at commit, allowing an abort after a successful request to be exercised.
function database(initial) {
  const stores = { settings: new Map(), bundles: new Map(), ...initial };
  const control = { abortWrites: false, stores };
  const db = {
    close() {},
    transaction(name, mode) {
      const transaction = {
        objectStore() {
          function request(action, write) {
            const result = {};
            queueMicrotask(() => {
              result.result = action(false);
              result.onsuccess?.();
              setImmediate(() => {
                if (mode === 'readwrite' && control.abortWrites) {
                  transaction.error = new DOMException('Commit failed', 'AbortError');
                  transaction.onabort?.();
                } else {
                  if (write) action(true);
                  transaction.oncomplete?.();
                }
              });
            });
            return result;
          }
          return {
            get: key => request(() => stores[name].get(key)),
            getAll: () => request(() => [...stores[name].values()].map(value => ({ ...value }))),
            put: (value, key = value.id) => request(commit => { if (commit) stores[name].set(key, value); return key; }, true),
            delete: key => request(commit => { if (commit) stores[name].delete(key); }, true),
          };
        },
      };
      return transaction;
    },
  };
  control.indexedDB = { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } };
  return control;
}

function folder(name, deletionError) {
  const root = {
    name, deleted: 0,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getDirectoryHandle: async name => {
      if (name === '.tms_data') throw new DOMException('Missing', 'NotFoundError');
      return { removeEntry: async () => {
      if (deletionError) throw deletionError;
      root.deleted++;
    } }; },
  };
  return root;
}

function setup(db, selected, authFetch, browserFetch) {
  return load('app/lib/offline.ts', {
    indexedDB: db.indexedDB, localStorage: storage(),
    window: { showDirectoryPicker: async () => selected },
    fetch: browserFetch,
  }, {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) },
    './auth': { getSessionUser: () => ({ id: 1, name: 'Test' }), authFetch },
    './offline-organization': organization,
  });
}

test('changing the default location preserves legacy bundle locations', async () => {
  const original = folder('Original'), selected = folder('New');
  const db = database({ settings: new Map([['directory', original]]), bundles: new Map([['id', { id: 'id', name: 'Movie', ownerId: 1 }]]) });
  const offline = setup(db, selected);
  await offline.chooseOfflineLocation();
  assert.equal(db.stores.bundles.get('id').directoryHandle, original);
  assert.equal(db.stores.settings.get('directory'), selected);
  await offline.removeOfflineBundle('id');
  assert.equal(original.deleted, 1);
  assert.equal(selected.deleted, 0);
});

test('failed filesystem removal retains the download for retry', async () => {
  const root = folder('Original', new DOMException('File is locked', 'NoModificationAllowedError'));
  const db = database({ bundles: new Map([['id', { id: 'id', name: 'Movie', ownerId: 1, directoryHandle: root }]]) });
  await assert.rejects(setup(db).removeOfflineBundle('id'), /File is locked/);
  assert.equal(db.stores.bundles.has('id'), true);
});

test('missing offline files can be removed from the catalog', async () => {
  const root = folder('Original', new DOMException('Already removed', 'NotFoundError'));
  const db = database({ bundles: new Map([['id', { id: 'id', name: 'Movie', ownerId: 1, directoryHandle: root }]]) });
  await setup(db).removeOfflineBundle('id');
  assert.equal(db.stores.bundles.has('id'), false);
});

test('a transaction abort after request success rejects the operation', async () => {
  const db = database();
  db.abortWrites = true;
  await assert.rejects(setup(db, folder('New')).chooseOfflineLocation(), /Commit failed/);
  assert.equal(db.stores.settings.has('directory'), false);
});

function downloadFolder() {
  const data = new Map();
  const removed = [];
  function directory(prefix = '') {
    return {
      name: 'Offline', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      getDirectoryHandle: async name => directory(`${prefix}${name}/`),
      removeEntry: async name => { data.delete(`${prefix}${name}`); removed.push(`${prefix}${name}`); },
      getFileHandle: async (name, options = {}) => {
        const key = `${prefix}${name}`;
        if (!options.create && !data.has(key)) throw new DOMException('Missing', 'NotFoundError');
        return {
          getFile: async () => ({ size: data.get(key) ?? 0 }),
          createWritable: async () => {
            let size = 0;
            return { write: async bytes => { size += bytes.length ?? bytes.size; }, close: async () => data.set(key, size), abort: async () => {} };
          },
        };
      },
    };
  }
  return { root: directory(), data, removed, prefix: 'TMS Offline/Sample Album-id/' };
}

const track = index => ({ id: `file-${index}`, path: `Music/Sample Album/${index}.mp3`, name: `${index}.mp3`,
  kind: 'audio', size: 4, url: `/media/${index}.mp3`, relativePath: `${index}.mp3` });
const catalog = (root, files) => ({ id: 'id', ownerId: 1, name: 'Sample Album', path: 'Music/Sample Album',
  kind: 'folder', status: 'ready', createdAt: 1, files, directoryHandle: root, totalBytes: files.length * 4, downloadedBytes: files.length * 4 });

test('browser sync brings 77 files to 78, downloads covers, and preserves existing media', async () => {
  const disk = downloadFolder();
  const files = Array.from({ length: 78 }, (_, i) => track(i));
  const old = files.slice(0, 77).map(file => ({ ...file, localUri: file.relativePath }));
  old.forEach(file => disk.data.set(disk.prefix + file.localUri, 4));
  const bundle = catalog(disk.root, old);
  const db = database({ bundles: new Map([['id', bundle]]) });
  const downloaded = [];
  const offline = setup(db, undefined, async url => { downloaded.push(url); return new Response(new Uint8Array(4)); });
  const covers = { 'Music/Sample Album': { ...track('cover'), kind: 'image', size: 0, url: '/folder-covers/cover.jpg' } };
  const updated = await offline.reconcileOfflineBundle(bundle, files, covers);
  assert.equal(updated.files.length, 78);
  assert.equal(updated.completedFiles, 78);
  assert.equal(updated.totalFiles, 78);
  assert.equal(updated.status, 'ready');
  assert.deepEqual(downloaded, ['/media/77.mp3', '/folder-covers/cover.jpg']);
  assert.equal(db.stores.bundles.get('id').files.length, 78);
  assert.equal(disk.removed.length, 0);
  assert.ok(updated.covers['Music/Sample Album'].localUri);
  assert.equal(updated.covers['Music/Sample Album'].localUri, '.tms_data/id/cover.mp3');
  assert.equal(disk.data.get('.tms_data/id/cover.mp3'), 4);
  downloaded.length = 0;
  await offline.reconcileOfflineBundle(updated, files, covers);
  assert.deepEqual(downloaded, []);
});

test('browser sync repairs truncated files and removes only obsolete media', async () => {
  const disk = downloadFolder();
  const old = [track(0), track(1), track(2)].map(file => ({ ...file, localUri: file.relativePath }));
  old.forEach(file => disk.data.set(disk.prefix + file.localUri, 4));
  disk.data.set(disk.prefix + '0.mp3', 2);
  const bundle = catalog(disk.root, old);
  const db = database({ bundles: new Map([['id', bundle]]) });
  const downloaded = [];
  const updated = await setup(db, undefined, async url => { downloaded.push(url); return new Response(new Uint8Array(4)); })
    .reconcileOfflineBundle(bundle, [track(0), track(1)]);
  assert.deepEqual(downloaded, ['/media/0.mp3']);
  assert.equal(updated.files.length, 2);
  assert.deepEqual(disk.removed, [disk.prefix + '2.mp3']);
  assert.equal(disk.data.get(disk.prefix + '0.mp3'), 4);
});

test('browser resync moves legacy cover art into the selected locations metadata folder without fetching media', async () => {
  const disk = downloadFolder();
  const media = { ...track(0), localUri: '0.mp3' };
  const cover = { ...track('cover'), kind: 'image', localUri: '.tms-folder-cover-123.jpg', relativePath: '.tms-folder-cover-123.jpg' };
  disk.data.set(disk.prefix + media.localUri, 4);
  disk.data.set(disk.prefix + cover.localUri, 4);
  const bundle = { ...catalog(disk.root, [media]), covers: { 'Music/Sample Album': cover } };
  const db = database({ bundles: new Map([['id', bundle]]) });
  const updated = await setup(db, undefined, async () => { throw new Error('Migration must not download anything'); })
    .reconcileOfflineBundle(bundle, [track(0)], { 'Music/Sample Album': cover });
  assert.equal(updated.covers['Music/Sample Album'].localUri, '.tms_data/id/.tms-folder-cover-123.jpg');
  assert.equal(disk.data.get('.tms_data/id/.tms-folder-cover-123.jpg'), 4);
  assert.equal(disk.data.has(disk.prefix + cover.localUri), false);
  assert.equal(disk.data.get(disk.prefix + '0.mp3'), 4);
  assert.deepEqual(disk.removed, [disk.prefix + '.tms-folder-cover-123.jpg']);
});

test('removing a browser download deletes its metadata directory along with its content', async () => {
  const disk = downloadFolder();
  const bundle = catalog(disk.root, []);
  const db = database({ bundles: new Map([['id', bundle]]) });
  await setup(db).removeOfflineBundle('id');
  assert.deepEqual(disk.removed, ['.tms_data/id', 'TMS Offline/Sample Album-id']);
  assert.equal(db.stores.bundles.has('id'), false);
});

test('a failed resync after migrating one cover preserves the art referenced by the restored catalog', async () => {
  const disk = downloadFolder();
  const media = { ...track(0), localUri: '0.mp3' };
  const cover = { ...track('cover'), kind: 'image', localUri: '.tms-cover.jpg', relativePath: '.tms-cover.jpg' };
  disk.data.set(disk.prefix + media.localUri, 4);
  disk.data.set(disk.prefix + cover.localUri, 4);
  const bundle = { ...catalog(disk.root, [media]), covers: { root: cover } };
  const db = database({ bundles: new Map([['id', bundle]]) });
  await assert.rejects(setup(db, undefined, async () => { throw new Error('Network lost'); })
    .reconcileOfflineBundle(bundle, [track(0)], { root: cover, nested: { ...track('nested'), kind: 'image' } }), /Network lost/);
  assert.equal(db.stores.bundles.get('id').covers.root.localUri, '.tms-cover.jpg');
  assert.equal(disk.data.get(disk.prefix + '.tms-cover.jpg'), 4);
  assert.deepEqual(disk.removed, []);
});

test('browser sync rejects incomplete downloads and leaves obsolete media for retry', async () => {
  const disk = downloadFolder();
  const old = [{ ...track(0), localUri: '0.mp3' }];
  disk.data.set(disk.prefix + '0.mp3', 4);
  const bundle = catalog(disk.root, old);
  const db = database({ bundles: new Map([['id', bundle]]) });
  await assert.rejects(setup(db, undefined, async () => new Response(new Uint8Array(2)))
    .reconcileOfflineBundle(bundle, [track(1)]), /Incomplete download/);
  assert.equal(db.stores.bundles.get('id').status, 'ready');
  assert.equal(db.stores.bundles.get('id').files[0].path, old[0].path);
  assert.equal(disk.data.get(disk.prefix + '0.mp3'), 4);
  assert.deepEqual(disk.removed, []);
});

test('browser sync requests existing folder access from the retry action', async () => {
  const root = folder('Original');
  root.queryPermission = async () => 'prompt';
  let requested = 0;
  root.requestPermission = async () => { requested++; return 'granted'; };
  const bundle = catalog(root, []);
  await setup(database()).authorizeOfflineSync(bundle);
  assert.equal(requested, 1);
});

test('Android sync receives the same new media and nested cover catalog', async () => {
  const calls = [];
  const plugin = {
    reconcile: async ({ bundle }) => { calls.push(['reconcile', bundle]); return { bundle }; },
    download: async ({ bundle, token }) => { calls.push(['download', token]); return { bundle: { ...bundle, status: 'ready' } }; },
  };
  const offline = load('app/lib/offline.ts', {}, {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true }, registerPlugin: () => plugin },
    './auth': { getSessionToken: () => 'test-token' },
    './offline-organization': organization,
  });
  const files = Array.from({ length: 78 }, (_, i) => track(i));
  const covers = { 'Music/Sample Album': { ...track('cover'), kind: 'image' }, 'Music/Sample Album/sub': { ...track('nested'), kind: 'image' } };
  const updated = await offline.reconcileOfflineBundle(catalog(undefined, files.slice(0, 77)), files, covers);
  assert.equal(updated.files.length, 78);
  assert.deepEqual(Object.keys(updated.covers).sort(), Object.keys(covers).sort());
  assert.equal(calls[0][0], 'reconcile');
  assert.deepEqual(calls[1], ['download', 'test-token']);
});

test('saved desktop folder permission is restored without reopening the folder picker', async () => {
  const root = folder('Original');
  let granted = false, requests = 0;
  root.queryPermission = async () => granted ? 'granted' : 'prompt';
  root.requestPermission = async () => { granted = true; requests++; return 'granted'; };
  const db = database({ settings: new Map([['directory', root]]) });
  const offline = setup(db);
  assert.equal((await offline.offlineLocation(true)).name, 'Original');
  await offline.offlineLocation(true);
  assert.equal(requests, 1);
  assert.equal(db.stores.settings.get('directory'), root);
});

test('a rejected saved folder grant keeps the location instead of discarding it', async () => {
  const root = folder('Original');
  root.queryPermission = async () => 'denied';
  root.requestPermission = async () => 'denied';
  const db = database({ settings: new Map([['directory', root]]) });
  await assert.rejects(setup(db).offlineLocation(true), /saved offline folder/);
  assert.equal((await setup(db).offlineLocation()).configured, true);
});

test('opening offline artwork needs only a read grant, not renewed write permission', async () => {
  const modes = [];
  const root = {
    name: 'Saved',
    queryPermission: async ({ mode }) => { modes.push(mode); return mode === 'read' ? 'granted' : 'prompt'; },
    requestPermission: async () => { throw new Error('Must not request write access to read art'); },
    getDirectoryHandle: async () => root,
    getFileHandle: async () => ({ getFile: async () => new Blob(['art'], { type: 'image/jpeg' }) }),
  };
  const art = { id: 'art', path: 'Library/Folder', name: 'cover.jpg', kind: 'image', relativePath: 'cover.jpg', localUri: 'cover.jpg' };
  const bundle = { ...catalog(root, []), covers: { 'Library/Folder': art } };
  const result = await setup(database({ bundles: new Map([['id', bundle]]) })).resolveOfflineFileUrl('id', 'art');
  assert.deepEqual(modes, ['read']);
  assert.match(result.url, /^blob:/);
  URL.revokeObjectURL(result.url);
});

test('external poster downloads omit credentials and never use the authenticated server client', async () => {
  const disk = downloadFolder();
  const bundle = catalog(disk.root, []);
  const db = database({ bundles: new Map([['id', bundle]]) });
  const requests = [];
  const offline = setup(db, undefined,
    async () => { throw new Error('Must not send server credentials to poster host'); },
    async (url, options) => { requests.push([url, options.credentials]); return new Response(new Uint8Array(4)); });
  const updated = await offline.reconcileOfflineBundle(bundle, [], {
    'Music/Sample Album': { ...track('cover'), kind: 'image', size: 0, public: true, url: 'https://posters.test/cover.jpg' },
  });
  assert.deepEqual(requests, [['https://posters.test/cover.jpg', 'omit']]);
  assert.ok(updated.covers['Music/Sample Album'].localUri);
});
