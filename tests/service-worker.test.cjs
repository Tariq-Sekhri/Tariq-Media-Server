const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function worker(fetch) {
  const events = {}, cached = new Map([['/index.html', new Response('<div id="root">React</div>')]]);
  const added = [];
  vm.runInNewContext(readFileSync('public/service-worker.js', 'utf8'), {
    self: { location: { origin: 'https://tms.test' }, addEventListener: (name, fn) => events[name] = fn, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => ({ addAll: async urls => added.push(...urls) }), match: async request => cached.get(typeof request === 'string' ? request : new URL(request.url).pathname), keys: async () => [], delete: async () => true },
    fetch, URL, Response, AbortSignal,
  });
  const request = (path, mode = 'navigate') => {
    let response;
    events.fetch({ request: { url: `https://tms.test${path}`, method: 'GET', mode }, respondWith: value => response = value });
    return response;
  };
  return { events, request, added };
}

test('installation caches the complete React entry and its assets', async () => {
  const app = worker(async () => Response.json(['/index.html', '/app-shell-assets/app.js', '/app-shell-assets/app.css']));
  let installed;
  app.events.install({ waitUntil: promise => installed = promise });
  await installed;
  assert.deepEqual(app.added, ['/index.html', '/app-shell-assets/app.js', '/app-shell-assets/app.css']);
});
for (const failure of ['network', '502']) {
  test(`${failure}: cold navigation to library and player receives React, not a static page`, async () => {
    const app = worker(async () => { if (failure === 'network') throw new TypeError('Failed to fetch'); return new Response('', { status: 502 }); });
    for (const path of ['/?section=offline', '/watch?offlineBundle=existing']) {
      assert.match(await (await app.request(path)).clone().text(), /id="root"/);
    }
    assert.equal(app.request('/api/libraries', 'cors'), undefined);
    assert.equal(app.request('/media/video.mp4', 'cors'), undefined);
  });
}
