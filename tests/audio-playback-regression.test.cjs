const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { libraryPlayback } = require('./load-ts.cjs');

// Run the actual handlers and provider render, rather than checking source text.
function handler(file, name, globals) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return vm.runInNewContext(ts.transpileModule(`(${found.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    URLSearchParams, beginPlaybackTrace: () => ({ id: 'attempt', startedAt: 1 }),
    playbackTracePhase() {}, writePlaybackTrace() {}, ...globals,
  });
}

function provider(session, playback, pathname = '/', userId = 7, resolve = async () => ({ url: 'content:resolved' })) {
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: { useCallback: fn => fn, useEffect() {}, useRef: current => ({ current }),
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useSyncExternalStore: (_, snapshot) => snapshot() },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/navigation': { usePathname: () => pathname },
    './lib/library-playback': playback,
    './MiniAudioPlayer': { default: () => null },
    './lib/auth': { getSessionUser: () => ({ id: userId }) },
    './lib/playback-queue': {},
    './lib/playback-session': { playbackSessionSnapshot: () => session.value,
      setPlaybackSession: next => { session.value = next; },
      selectPlaybackItem: (current, item, playing) => ({ ...current, item, playing }),
      playbackWatchUrl: () => '/watch?kind=video' },
    './lib/offline': { resolveOfflineFileUrl: resolve },
    './lib/app-shell': { useAppShell: () => ({ path: pathname }), navigateApp: url => session.navigations.push(url) },
    './lib/watch-progress': { readLocalWatchProgress: () => ({}) },
    './lib/native-watch-progress': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/PlaybackProvider.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, require: name => {
    assert.ok(name in imports, name); return imports[name];
  }, URL, window: { dispatchEvent() {} }, Event: class {} });
  const tree = module.exports.default({ children: 'browse' });
  function player(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.onItemChange) return node;
    return [node.props?.children].flat(Infinity).map(player).find(Boolean) ?? null;
  }
  return player(tree);
}

const audio = (extension, offline) => ({ id: extension, kind: 'audio', name: `Recording.${extension}`,
  path: `AudioLibrary/Recording.${extension}`, parent: 'AudioLibrary', size: '', tags: [],
  src: offline ? 'content:download' : `/media/AudioLibrary/Recording.${extension}`,
  ...(offline ? { offline: { bundleId: 'bundle', fileId: extension, status: 'ready' } } : {}),
});

for (const alongside of [false, true]) for (const offline of [false, true]) for (const extension of ['mp3', 'm4a']) {
  const label = `${offline ? 'offline' : 'server'} ${extension}, alongside ${alongside}`;
  const playback = libraryPlayback({ audiolibrary: { alongside } }, { native: true });

  test(`tap/Play all/Shuffle starts an audio player without Watch: ${label}`, () => {
    const entry = audio(extension, offline);
    for (const method of ['item', 'all', 'shuffle']) {
      const session = { value: null, navigations: [] };
      const play = handler('app/page.tsx', 'playVideo', {
        ...playback, libraries: {}, sessionUser: { id: 7 }, readPlayback: () => null,
        readLocalWatchProgress: () => ({}), savesWatchProgress: () => true,
        window: { location: { pathname: '/', search: offline ? '?section=offline' : '?folder=AudioLibrary' } },
        queueSourceForItem: source => source,
        startPlaybackSession: input => { session.value = { ...input, id: 'session' }; return session.value; },
        recordAccess() {}, navigateApp: url => { session.navigations.push(url); throw Error('Audio entered Watch'); },
      });
      play(entry, undefined, [entry], method);
      assert.equal(session.value.playing, true);
      assert.equal(session.value.watchEntry, false);
      assert.deepEqual(session.navigations, []);
      const rendered = provider(session, playback);
      assert.ok(rendered, 'session must have a player, not just a highlighted card');
      assert.equal(rendered.props.item.src, entry.src);
      assert.equal(rendered.props.initialPlaying, true);
    }
  });

  test(`audio queue selection never navigates to Watch: ${label}`, async () => {
    const entry = audio(extension, offline);
    const session = { value: { id: 'session', userId: 7, item: entry, queue: [entry], playing: true }, navigations: [] };
    const rendered = provider(session, playback);
    assert.ok(rendered);
    // onItemChange deliberately returns void; wait for offline URL resolution.
    rendered.props.onItemChange(entry, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.value.item.src, offline ? 'content:resolved' : entry.src);
    assert.deepEqual(session.navigations, []);
    assert.ok(provider(session, playback));
  });
}

test('offline item tap resolves its local file and renders a player with alongside enabled', async () => {
  const entry = audio('mp3', true);
  const session = { value: null, navigations: [] };
  const open = handler('app/page.tsx', 'openDownloadedFile', {
    playableVisible: [entry], sessionUser: { id: 7 },
    resolveOfflineFileUrl: async () => ({ url: 'content:resolved' }),
    startPlaybackSession: input => { session.value = { ...input, id: 'session' }; },
    window: { location: { pathname: '/', search: '?section=offline' } },
    flash: message => assert.fail(message),
  });
  await open({ id: 'bundle', name: 'Downloads' }, { id: 'mp3', kind: 'audio' }, entry);
  assert.equal(session.value.item.src, 'content:resolved');
  assert.equal(session.value.playing, true);
  assert.ok(provider(session, libraryPlayback({ audiolibrary: { alongside: true } }, { native: true })));
});

test('alongside audio stays mounted during video navigation; regular audio yields to Watch', () => {
  const entry = audio('mp3');
  const session = { value: { id: 'session', userId: 7, item: entry, queue: [entry], playing: true }, navigations: [] };
  for (const alongside of [true, false]) {
    const playback = libraryPlayback({ audiolibrary: { alongside } }, { native: true });
    assert.equal(Boolean(provider(session, playback, '/watch')), alongside);
    assert.equal(provider(session, playback, '/', 99), null, 'never expose another account player');
  }
});

test('legacy audio URLs never allocate a companion video player', () => {
  const playback = libraryPlayback({ audiolibrary: { alongside: true } }, { native: true });
  for (const offline of [false, true]) {
    const url = `/watch?kind=audio&path=AudioLibrary/Recording.mp3${offline ? '&offlineBundle=b&offlineFile=f' : '&src=/media/AudioLibrary/Recording.mp3'}`;
    assert.equal(playback.watchPlaysAlongside(url), false);
  }
  assert.equal(playback.watchPlaysAlongside('/watch?kind=video&path=AudioLibrary/Video.mp4'), true);
});

test('legacy server audio bypasses video inspection while recovering to the audio player', () => {
  const file = 'app/watch/page.tsx';
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('setAudioCompatibilityChecked(false)')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  const state = {};
  const run = vm.runInNewContext(ts.transpileModule(`(${effect.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    details: { ...audio('mp3'), offline: false }, directPlaybackCompatibleRef: { current: false },
    setAudioCompatibilityChecked: value => { state.compatible = value; },
    setAudioTracksLoaded: value => { state.tracksLoaded = value; },
    setAudioTracks() {}, setSelectedAudioStream() {},
    detailsMediaPath: () => assert.fail('audio must not be probed as video'),
    fetch: () => assert.fail('audio must not request video qualities'),
  });
  run();
  assert.deepEqual(state, { compatible: true, tracksLoaded: true });
});

test('starting alongside audio preserves an existing minimized video', () => {
  for (const alongside of [true, false]) {
    const entry = audio('mp3');
    let closed = false;
    const run = handler('app/AppShell.tsx', 'stopVideoForAudio', {
      playbackSessionSnapshot: () => ({ item: entry }),
      appShellSnapshot: () => ({ watch: { mode: 'mini' } }),
      playsAlongside: () => alongside,
      closeWatch: () => { closed = true; },
    });
    run();
    assert.equal(closed, !alongside);
  }
});

test('a mixed audio queue still opens video and images in Watch', async () => {
  const entry = audio('mp3');
  for (const kind of ['video', 'image']) {
    const session = { value: { id: 'session', userId: 7, item: entry, queue: [entry], playing: true }, navigations: [] };
    provider(session, libraryPlayback()).props.onItemChange({ ...entry, kind }, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.value.item.kind, kind);
    assert.equal(session.navigations.length, 1);
  }
});

test('closing playback during offline resolution cannot resurrect a player', async () => {
  const entry = audio('mp3', true);
  const session = { value: { id: 'session', userId: 7, item: entry, queue: [entry], playing: true }, navigations: [] };
  let resolveFile;
  provider(session, libraryPlayback(), '/', 7, () => new Promise(resolve => { resolveFile = resolve; }))
    .props.onItemChange(entry, true);
  session.value = null;
  resolveFile({ url: 'content:late' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.value, null);
  assert.deepEqual(session.navigations, []);
});
