const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage, libraryPlayback } = require('./load-ts.cjs');

function origin(device, ownerId) {
  const localStorage = storage();
  const progress = load('app/lib/watch-progress.ts', { window: { localStorage } }, {
    './library-playback': libraryPlayback({}, { localStorage }),
  });
  const bridge = load('app/lib/native-watch-progress.ts', {}, {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true }, registerPlugin: () => ({
      getOfflineWatchProgress: async ({ ownerId }) => ({ playback: device[ownerId] ?? {} }),
      saveOfflineWatchProgress: async ({ ownerId, path, state }) => { (device[ownerId] ??= {})[path] = state; },
    }) },
    './auth': { getSessionUser: () => ({ id: ownerId }) },
    './watch-progress': progress,
  });
  return { progress, bridge };
}

test('offline Android shell progress reaches the connected origin and uploads on reconnect', async () => {
  const device = {};
  const offline = origin(device, 1);
  const cleanup = offline.bridge.connectNativeWatchProgress();
  offline.progress.writeLocalWatchProgress(1, 'Library/episode.mp4', { position: 50, duration: 100, updated: 20 });
  cleanup();
  const online = origin(device, 1);
  await online.bridge.hydrateNativeWatchProgress();
  const sent = [];
  await online.progress.syncLocalWatchProgress({}, online.progress.readLocalWatchProgress(1), async (path, state) => sent.push([path, state.position]));
  assert.deepEqual(sent, [['Library/episode.mp4', 50]]);
});

test('device progress is isolated by account and does not overwrite a newer local edit', async () => {
  const device = { 1: { 'Library/video.mp4': { position: 40, duration: 100, updated: 10 } } };
  const online = origin(device, 1);
  online.progress.writeLocalWatchProgress(1, 'Library/video.mp4', { position: 70, duration: 100, updated: 30 });
  await online.bridge.hydrateNativeWatchProgress();
  assert.equal(online.progress.readLocalWatchProgress(1)['Library/video.mp4'].position, 70);
  const other = origin(device, 2);
  await other.bridge.hydrateNativeWatchProgress();
  assert.equal(Object.keys(other.progress.readLocalWatchProgress(2)).length, 0);
});
