const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');

const nativeMediaSession = () => {
  const handlers = new Map();
  const calls = [];
  let releaseNone = null;
  const MediaSession = {
    setActionHandler: ({ action }, callback) => {
      calls.push(callback ? `set:${action}` : `remove:${action}`);
      if (callback) handlers.set(action, callback); else handlers.delete(action);
      // Like Capacitor, a kept callback's promise stays pending.
      return callback ? new Promise(() => {}) : Promise.resolve();
    },
    removeActionHandler: async ({ action }) => {
      calls.push(`remove:${action}`);
      handlers.delete(action);
    },
    setMetadata: async () => {},
    setPositionState: async () => {},
    setFavoriteState: async () => {},
    setPlaybackState: ({ playbackState }) => {
      calls.push(`state:${playbackState}`);
      // Hold the first "none" open so a new player can sync during the clear.
      if (playbackState === 'none' && !releaseNone) return new Promise((resolve) => { releaseNone = resolve; });
      return Promise.resolve();
    },
  };
  const module = load('app/lib/native-media-session.ts', { window: { setTimeout, clearTimeout } }, {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true } },
    '@capgo/capacitor-media-session': { MediaSession },
  });
  return { module, handlers, calls, finishNone: () => releaseNone?.() };
};

const player = (log, name) => ({
  onPlay: () => log.push(`${name}:play`),
  onPause: () => log.push(`${name}:pause`),
  onSeekBackward: () => {},
  onSeekForward: () => {},
  onPrevious: () => {},
  onNext: () => {},
  onSeekTo: () => {},
});

const state = { title: 'Track', duration: 120, position: 3, playing: false, hasPrevious: true, hasNext: true };

test('a player that syncs while the previous clear is pending keeps play/pause handlers', async () => {
  const { module, handlers, calls, finishNone } = nativeMediaSession();
  const log = [];
  await module.syncNativeMediaSession(player(log, 'old'), state);
  assert.ok(handlers.has('play') && handlers.has('pause'));

  // Old player unmounts; the new player mounts before the clear settles.
  const clearing = module.clearNativeMediaSession();
  const syncing = module.syncNativeMediaSession(player(log, 'new'), { ...state, title: 'Next track' });
  await syncing;
  finishNone();
  await clearing;

  assert.ok(handlers.has('play'), `play handler missing after remount: ${calls.join(', ')}`);
  assert.ok(handlers.has('pause'), `pause handler missing after remount: ${calls.join(', ')}`);
  // Native teardown is issued before the new player's registrations.
  assert.ok(calls.lastIndexOf('remove:play') < calls.lastIndexOf('set:play'));
  assert.ok(calls.indexOf('state:none') < calls.lastIndexOf('state:paused'));

  handlers.get('play')({});
  handlers.get('pause')({});
  assert.deepEqual(log, ['new:play', 'new:pause']);
});

test('clearing the session removes every native action handler', async () => {
  const { module, handlers, finishNone } = nativeMediaSession();
  await module.syncNativeMediaSession(player([], 'only'), state);
  const clearing = module.clearNativeMediaSession();
  finishNone();
  await clearing;
  assert.equal(handlers.size, 0);
});
