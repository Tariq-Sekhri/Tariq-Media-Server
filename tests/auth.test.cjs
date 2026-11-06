const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage } = require('./load-ts.cjs');

function setup(fetch = async () => new Response(null, { status: 200 })) {
  const localStorage = storage();
  const redirects = [];
  const auth = load('app/lib/auth.ts', {
    localStorage, fetch, navigator: { platform: 'test', userAgent: 'test' },
    crypto: { randomUUID: () => 'device' },
    window: { location: { pathname: '/', replace: (url) => redirects.push(url) } },
  }, { './media': { API_BASE: '' } });
  return { auth, localStorage, redirects };
}

test('an expired legacy access token is replaced locally with its permanent device credential', async () => {
  const requests = [];
  const { auth, localStorage } = setup(async (url, init) => {
    requests.push({ url, authorization: init.headers.get('Authorization') });
    return new Response(null, { status: 200 });
  });
  localStorage.setItem(auth.SESSION_TOKEN_KEY, 'expired-access');
  localStorage.setItem(auth.SESSION_REFRESH_TOKEN_KEY, 'device-secret');
  localStorage.setItem(auth.SESSION_EXPIRES_AT_KEY, '1');
  localStorage.setItem(auth.SESSION_USER_KEY, JSON.stringify({ id: 1, name: 'Test' }));

  assert.equal(auth.hasActiveCachedSession(), true);
  assert.equal(auth.getSessionToken(), 'device-secret');
  assert.equal(localStorage.getItem(auth.SESSION_REFRESH_TOKEN_KEY), null);
  assert.equal(localStorage.getItem(auth.SESSION_EXPIRES_AT_KEY), null);
  await auth.authFetch('/api/library');
  assert.deepEqual(requests.map(request => request.url), ['/api/library']);
  assert.equal(requests[0].authorization, 'Bearer device-secret');
});

test('a remembered login remains usable without a session expiry or server check', () => {
  const { auth } = setup(() => { throw new Error('server offline'); });
  auth.rememberSession('device-secret', { id: 1, name: 'Test' });
  assert.equal(auth.hasActiveCachedSession(), true);
  assert.equal(auth.getSessionToken(), 'device-secret');
});

test('a confirmed unauthorized response logs out the current device', async () => {
  const { auth, redirects } = setup(async () => new Response(null, { status: 401 }));
  auth.rememberSession('device-secret', { id: 1, name: 'Test' });
  assert.equal((await auth.authFetch('/api/library')).status, 401);
  assert.equal(auth.getSessionToken(), '');
  assert.deepEqual(redirects, ['/login']);
});

test('a network failure keeps the remembered login', async () => {
  const { auth, redirects } = setup(async () => { throw new Error('server offline'); });
  auth.rememberSession('device-secret', { id: 1, name: 'Test' });
  await assert.rejects(auth.authFetch('/api/library'), /server offline/);
  assert.equal(auth.getSessionToken(), 'device-secret');
  assert.deepEqual(redirects, []);
});

test('logout clears the local login when the server is offline', async () => {
  const { auth } = setup(async () => { throw new Error('server offline'); });
  auth.rememberSession('device-secret', { id: 1, name: 'Test' });
  await auth.logOut();
  assert.equal(auth.getSessionToken(), '');
});

test('a late response from an old account cannot log out a newer login', async () => {
  let finish;
  const { auth } = setup(() => new Promise(resolve => { finish = resolve; }));
  auth.rememberSession('old', { id: 1, name: 'Old' });
  const pending = auth.authFetch('/api/library');
  auth.rememberSession('new', { id: 2, name: 'New' });
  finish(new Response(null, { status: 401 }));
  await pending;
  assert.equal(auth.getSessionToken(), 'new');
});
