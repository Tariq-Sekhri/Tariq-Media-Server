const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');

function database() {
  const images = new Map();
  const control = { images, failWrites: false };
  const db = {
    transaction() {
      const transaction = {
        objectStore: () => ({
          get(key) {
            const request = {};
            queueMicrotask(() => { request.result = images.get(key); request.onsuccess(); });
            return request;
          },
          put(image, key) {
            queueMicrotask(() => {
              if (control.failWrites) { transaction.onabort(); return; }
              images.set(key, image);
              transaction.oncomplete();
            });
          },
        }),
      };
      return transaction;
    },
  };
  control.indexedDB = { open() {
    const request = { result: db };
    queueMicrotask(() => request.onsuccess());
    return request;
  } };
  return control;
}
const setup = (db, fetch) => load('app/lib/artwork-cache.ts', {
  indexedDB: db.indexedDB, fetch, window: { location: { href: 'http://localhost:3000/' } },
});
const imageResponse = () => new Response('poster bytes', { headers: { 'content-type': 'image/webp' } });

test('poster bytes survive a fresh module load offline without another request', async () => {
  const db = database();
  let downloads = 0;
  const online = setup(db, async url => {
    downloads++;
    assert.ok(url.startsWith('/artwork-image?'));
    return imageResponse();
  });
  const src = 'https://images.metahub.space/poster/small/tt0487831/img';
  const [a, b] = await Promise.all([online.loadArtwork(src, '1'), online.loadArtwork(src, '1')]);
  assert.equal(downloads, 1);
  assert.equal(a, b);
  const offline = setup(db, () => { throw new Error('No Wi-Fi'); });
  assert.equal(await (await offline.loadArtwork(src, '1')).text(), 'poster bytes');
});

test('changed artwork URLs and different users have separate saved images', async () => {
  const db = database();
  let downloads = 0;
  const cache = setup(db, async () => { downloads++; return imageResponse(); });
  await cache.loadArtwork('/folder-covers/show?v=1', '1');
  await cache.loadArtwork('/folder-covers/show?v=2', '1');
  await cache.loadArtwork('/folder-covers/show?v=1', '2');
  await cache.loadArtwork('/folder-covers/show?v=1', '1');
  assert.equal(downloads, 3);
});

test('failed or non-image downloads are not saved and can be retried', async () => {
  const db = database();
  let calls = 0;
  const cache = setup(db, async () => {
    calls++;
    if (calls === 1) return new Response('unavailable', { status: 503 });
    if (calls === 2) return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
    return imageResponse();
  });
  await assert.rejects(cache.loadArtwork('/cover', '1'));
  await assert.rejects(cache.loadArtwork('/cover', '1'));
  assert.equal(db.images.size, 0);
  await cache.loadArtwork('/cover', '1');
  assert.equal(db.images.size, 1);
});

test('storage failure still displays downloaded artwork', async () => {
  const db = database();
  db.failWrites = true;
  const cache = setup(db, async () => imageResponse());
  assert.equal(await (await cache.loadArtwork('/cover', '1')).text(), 'poster bytes');
  assert.equal(db.images.size, 0);
});

test('artwork relay rejects unapproved destinations and upstream redirects', async () => {
  let calls = 0;
  const route = load('app/artwork-image/route.ts', { fetch: async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return imageResponse();
  } });
  for (const url of ['http://127.0.0.1/secret', 'https://example.com/poster', 'https://image.tmdb.org:444/poster', 'https://user:pass@image.tmdb.org/poster']) {
    assert.equal((await route.GET(new Request(`http://localhost/artwork-image?url=${encodeURIComponent(url)}`))).status, 400);
  }
  assert.equal(calls, 0);
  const result = await route.GET(new Request('http://localhost/artwork-image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw342%2Fposter.jpg'));
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'poster bytes');
  assert.equal(calls, 1);
});
