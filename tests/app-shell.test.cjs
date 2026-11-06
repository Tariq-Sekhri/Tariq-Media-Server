const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load, storage } = require('./load-ts.cjs');

// A small same-document browser: pushState/replaceState/back and popstate.
function browser(start, desktop) {
  const origin = 'http://tms.test';
  const entries = [{ url: start, state: null }];
  let index = 0;
  const listeners = new Set();
  const loads = [];
  const at = () => new URL(entries[index].url, origin);
  const fire = () => listeners.forEach((listener) => listener({ type: 'popstate', state: entries[index].state }));
  const window = {
    location: {
      origin,
      get pathname() { return at().pathname; },
      get search() { return at().search; },
      get href() { return at().href; },
      assign: (url) => loads.push(['assign', url]),
      replace: (url) => loads.push(['replace', url]),
    },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _title, url) {
        entries.splice(index + 1);
        entries.push({ url, state: structuredClone(state) });
        index = entries.length - 1;
      },
      replaceState(state, _title, url) { entries[index] = { url: url ?? entries[index].url, state: structuredClone(state) }; },
      back() { if (index > 0) { index -= 1; fire(); } },
      forward() { if (index < entries.length - 1) { index += 1; fire(); } },
    },
    addEventListener(type, listener) { if (type === 'popstate') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'popstate') listeners.delete(listener); },
    dispatchEvent() { fire(); return true; },
    matchMedia: (query) => ({ matches: query === '(hover: hover) and (pointer: fine)' && desktop }),
  };
  class PopStateEvent { constructor(type, init) { this.type = type; this.state = init?.state; } }
  return { window, PopStateEvent, loads, entries, url: () => entries[index].url, index: () => index };
}

// Touch screens by default; desktop opts in to mouse-and-hover behavior.
// The Sleep library is set to play alongside other media on this device.
function alongsidePlayback(native) {
  const localStorage = storage();
  localStorage.setItem('tms:library-playback', JSON.stringify({ sleep: { alongside: true } }));
  return load('app/lib/library-playback.ts', { window: { localStorage, ...(native ? { Capacitor: { isNativePlatform: () => true } } : {}) } });
}
function shell(start, { desktop = false, nativeAlongside = false } = {}) {
  const b = browser(start, desktop);
  const module = load('app/lib/app-shell.ts', { window: b.window, PopStateEvent: b.PopStateEvent }, { react: { useSyncExternalStore() {} }, './library-playback': alongsidePlayback(nativeAlongside) });
  module.startAppShell();
  return { ...module, b };
}

test('source files contain no UTF-8 decoded as Windows-1252', () => {
  for (const dir of ['app', 'app/lib', 'app/watch', 'tests']) {
    for (const file of fs.readdirSync(dir).filter((name) => /\.(tsx?|css|cjs)$/.test(name))) {
      assert.doesNotMatch(fs.readFileSync(`${dir}/${file}`, 'utf8'), new RegExp(String.fromCharCode(0xe2, 0x20ac)), `${dir}/${file}`);
    }
  }
});

const watchUrl = (name, extra = '') => `/watch?src=%2Fmedia%2FLib%2F${name}.mkv&name=${name}&return=%2F%3Ffolder%3DLib${extra}`;

test('leaving Watch returns to the library and keeps the same player as a mini player', () => {
  const s = shell('/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch, null);
  s.navigateApp(watchUrl('a'));
  const opened = s.appShellSnapshot().watch;
  assert.equal(opened.mode, 'full');
  assert.equal(s.b.url(), watchUrl('a'));
  assert.equal(s.b.entries.length, 2, 'opening Watch adds one history entry');

  s.minimizeWatch('/?folder=Lib');
  assert.equal(s.b.url(), '/?folder=Lib', 'Back returns to the exact page that opened Watch');
  assert.equal(s.appShellSnapshot().watch.id, opened.id, 'the player instance is not remounted');
  assert.equal(s.appShellSnapshot().watch.mode, 'mini');
  assert.deepEqual(s.b.loads, [], 'no document load interrupts playback');
});

test('expanding the mini player restores the live instance at its current queue item', () => {
  const s = shell('/?folder=Lib');
  s.navigateApp(watchUrl('a'));
  const id = s.appShellSnapshot().watch.id;
  s.minimizeWatch('/?folder=Lib');
  // The queue advances while the user browses the library.
  s.replaceWatchLocation(watchUrl('b'));
  assert.equal(s.b.url(), '/?folder=Lib', 'a minimized player never rewrites the library URL');
  assert.match(s.watchLocationSearch(), /name=b/);

  s.expandWatch();
  assert.equal(s.appShellSnapshot().watch.id, id);
  assert.equal(s.appShellSnapshot().watch.mode, 'full');
  assert.equal(s.b.url(), watchUrl('b'));
  assert.deepEqual(s.b.loads, []);
});

test('browser Forward to an older Watch entry shows the live player, not a restart', () => {
  const s = shell('/?folder=Lib');
  s.navigateApp(watchUrl('a'));
  const id = s.appShellSnapshot().watch.id;
  s.b.window.history.back();
  s.replaceWatchLocation(watchUrl('b'));
  s.b.window.history.forward();
  assert.equal(s.appShellSnapshot().watch.id, id);
  assert.equal(s.appShellSnapshot().watch.mode, 'full');
  assert.equal(s.b.url(), watchUrl('b'));
});

test('a Watch page opened directly is replaced by its return URL when minimized', () => {
  const s = shell(watchUrl('a'));
  const id = s.appShellSnapshot().watch.id;
  assert.equal(s.appShellSnapshot().watch.mode, 'full');
  s.minimizeWatch('/?folder=Lib');
  assert.equal(s.b.entries.length, 1, 'there is no library entry to go back to, so Watch is replaced');
  assert.equal(s.b.url(), '/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch.id, id);
  assert.equal(s.appShellSnapshot().watch.mode, 'mini');
  assert.deepEqual(s.b.loads, []);
});

test('after a reload, Back does not traverse into the previous document', () => {
  const s = shell('/?folder=Lib');
  // History state written by an earlier document survives a reload.
  s.b.window.history.pushState({ tmsWatchId: 'old', tmsWatchFromShell: true, tmsDocument: 'earlier' }, '', watchUrl('a'));
  s.syncAppShell();
  s.minimizeWatch('/?folder=Lib');
  assert.equal(s.b.index(), 1, 'the Watch entry is replaced; going back would load the old document');
  assert.equal(s.b.url(), '/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch.mode, 'mini');
});

test('playing other media replaces the player; the same media expands it', () => {
  const s = shell('/?folder=Lib');
  s.navigateApp(watchUrl('a'));
  const first = s.appShellSnapshot().watch.id;
  s.minimizeWatch('/?folder=Lib');
  s.navigateApp(watchUrl('a', '&start=30'));
  assert.equal(s.appShellSnapshot().watch.id, first);
  assert.equal(s.b.url(), watchUrl('a'), 'the live player keeps its own position');
  s.minimizeWatch('/?folder=Lib');
  s.navigateApp(watchUrl('c'));
  assert.notEqual(s.appShellSnapshot().watch.id, first);
  assert.equal(s.appShellSnapshot().watch.mode, 'full');
});

test('closing the mini player ends it without navigating', () => {
  const s = shell('/?folder=Lib');
  s.navigateApp(watchUrl('a'));
  s.minimizeWatch('/?folder=Lib');
  s.closeWatch();
  assert.equal(s.appShellSnapshot().watch, null);
  assert.equal(s.b.url(), '/?folder=Lib');
  assert.deepEqual(s.b.loads, []);
});

test('handing a full Watch page to audio leaves Watch in place', () => {
  const s = shell(watchUrl('a'));
  s.closeWatch('/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch, null);
  assert.equal(s.b.url(), '/?folder=Lib');
  assert.deepEqual(s.b.loads, [], 'the audio mini player starts without a page load');
});

test('library links keep normal navigation unless a video is playing', () => {
  const s = shell('/?folder=Lib');
  s.navigateApp('/?folder=Other');
  assert.deepEqual(s.b.loads, [['assign', 'http://tms.test/?folder=Other']]);
  s.navigateApp(watchUrl('a'));
  s.minimizeWatch('/?folder=Lib');
  s.navigateApp('/?folder=Other');
  assert.equal(s.b.url(), '/?folder=Other');
  assert.equal(s.b.loads.length, 1, 'browsing with the mini player open stays in the document');
  s.navigateApp('/admin');
  assert.deepEqual(s.b.loads.at(-1), ['assign', 'http://tms.test/admin']);
});

test('the Android back button only minimizes a full Watch page', () => {
  const s = shell('/?folder=Lib');
  let backs = 0;
  s.setWatchBackHandler(() => { backs += 1; });
  assert.equal(s.handleWatchBack(), false);
  s.navigateApp(watchUrl('a'));
  assert.equal(s.handleWatchBack(), true);
  s.minimizeWatch('/?folder=Lib');
  assert.equal(s.handleWatchBack(), false, 'in the library, Back belongs to the library');
  assert.equal(backs, 1);
});

test('on desktop, leaving Watch stops the video unless the mini player was requested', () => {
  const s = shell('/?folder=Lib', { desktop: true });
  s.navigateApp(watchUrl('a'));
  s.b.window.history.back();
  assert.equal(s.appShellSnapshot().watch, null, 'browser Back stops playback, as on YouTube');

  s.navigateApp(watchUrl('a'));
  s.leaveWatch('/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch, null, 'the player Back button stops playback');
  assert.equal(s.b.url(), '/?folder=Lib');

  s.navigateApp(watchUrl('a'));
  const id = s.appShellSnapshot().watch.id;
  s.minimizeWatch('/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch.id, id, 'the miniplayer button or "i" keeps it playing');
  assert.equal(s.appShellSnapshot().watch.mode, 'mini');
  // A later Back in the library must not reuse that one-time request.
  s.expandWatch();
  s.b.window.history.back();
  assert.equal(s.appShellSnapshot().watch, null);
  assert.deepEqual(s.b.loads, []);
});

test('on touch screens, leaving Watch keeps the video in the mini player', () => {
  const s = shell('/?folder=Lib');
  s.navigateApp(watchUrl('a'));
  const id = s.appShellSnapshot().watch.id;
  s.leaveWatch('/?folder=Lib');
  assert.equal(s.appShellSnapshot().watch.id, id);
  assert.equal(s.appShellSnapshot().watch.mode, 'mini');
  s.expandWatch();
  s.b.window.history.back();
  assert.equal(s.appShellSnapshot().watch.mode, 'mini', 'browser and Android Back also keep it playing');
});

test('dragging the mini player past a side edge dismisses it', () => {
  const p = load('app/lib/mini-player-position.ts');
  assert.equal(p.miniPlayerOverflow(12, 12, 300), 0, 'inside the viewport');
  assert.ok(p.miniPlayerOverflow(-120, 12, 300) >= p.MINI_PLAYER_DISMISS_FRACTION, 'thrown past the right edge');
  assert.ok(p.miniPlayerOverflow(1100, 968, 300) >= p.MINI_PLAYER_DISMISS_FRACTION, 'thrown past the left edge');
  assert.ok(p.miniPlayerOverflow(-30, 12, 300) < p.MINI_PLAYER_DISMISS_FRACTION, 'a small overshoot snaps back');
});

test('mini player position stays inside the viewport', () => {
  const p = load('app/lib/mini-player-position.ts');
  const size = { width: 400, height: 280 };
  const viewport = { width: 1280, height: 720 };
  assert.deepEqual({ ...p.clampMiniPlayerPosition({ right: -50, bottom: 9000 }, size, viewport) }, { right: 12, bottom: 428 });
  assert.deepEqual({ ...p.clampMiniPlayerPosition({ right: 100.4, bottom: 60.6 }, size, viewport) }, { right: 100, bottom: 61 });
  assert.deepEqual({ ...p.parseMiniPlayerPosition('{"right":40,"bottom":50}', false) }, { right: 40, bottom: 50 });
  assert.deepEqual({ ...p.parseMiniPlayerPosition('nope', true) }, { right: 12, bottom: 84 });
  assert.deepEqual({ ...p.parseMiniPlayerPosition(null, false) }, { right: 12, bottom: 20 });
});

test('leaving a video minimizes it instead of stopping its stream', () => {
  const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
  const leave = source.slice(source.indexOf('  const leaveToLibrary = async () => {'), source.indexOf('  const leaveToLibraryLatest ='));
  assert.ok(leave.indexOf('leaveWatch(') > 0 && leave.indexOf('leaveWatch(') < leave.indexOf('stopActiveTranscode'));
  assert.match(source, /toggleMiniplayerLatest\(\)/, 'the "i" key toggles the mini player');
  assert.match(source, /onMiniplayer=\{openMiniplayer\}/, 'the controls offer a miniplayer button');
  assert.doesNotMatch(source, /useRouter|window\.location\.(assign|replace)|window\.history\.replaceState/);
  const home = fs.readFileSync('app/page.tsx', 'utf8');
  assert.doesNotMatch(home, /window\.location\.assign\(`\/watch/);
});

test('a native play-alongside library keeps one independent player across other-library selections', () => {
  const s = shell('/', { nativeAlongside: true });
  s.navigateApp('/watch?src=/media/Sleep/a.mp4&path=Sleep/a.mp4');
  const companion = s.appShellSnapshot().companion.id;
  s.minimizeCompanionWatch();
  s.navigateApp('/watch?src=/media/Movies/b.mp4&path=Movies/b.mp4');
  const movie = s.appShellSnapshot().watch.id;
  assert.equal(s.appShellSnapshot().companion.id, companion);
  assert.equal(s.appShellSnapshot().companion.mode, 'mini');
  s.navigateApp('/watch?src=/media/Sleep/c.mp4&path=Sleep/c.mp4');
  assert.notEqual(s.appShellSnapshot().companion.id, companion);
  assert.equal(s.appShellSnapshot().watch.id, movie);
  s.closeCompanionWatch();
  assert.equal(s.appShellSnapshot().companion, null);
  assert.equal(s.appShellSnapshot().watch.id, movie);
});
test('on the web a play-alongside library uses the normal single player in this tab', () => {
  const s = shell('/', { desktop: true });
  s.navigateApp('/watch?src=/media/Sleep/a.mp4&path=Sleep/a.mp4');
  assert.equal(s.appShellSnapshot().companion, null);
  assert.ok(s.appShellSnapshot().watch);
});

test('a direct native play-alongside URL creates the independent slot', () => {
  const s = shell('/watch?src=/media/Sleep/a.mp3&path=Sleep/a.mp3', { nativeAlongside: true });
  assert.equal(s.appShellSnapshot().watch, null);
  assert.equal(s.appShellSnapshot().companion.mode, 'full');
});
