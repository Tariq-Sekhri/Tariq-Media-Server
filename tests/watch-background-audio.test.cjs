const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
const ast = ts.createSourceFile('watch.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function load(context, name) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer.getText(ast);
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) initializer = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, name);
  return vm.runInContext(ts.transpile(`(${initializer})`, { target: ts.ScriptTarget.ES2022 }), context);
}
const ref = (current) => ({ current });

test('next video retains audio mode and promotes a ready preload outside picture-in-picture', () => {
  for (const [background, ready, pip] of [[false, false, false], [true, false, false], [false, true, false], [false, true, true]]) {
    const video = { pause() {}, currentTime: 50 };
    const context = vm.createContext({
      details: { kind: 'video', src: '/one', path: 'one' }, videoRef: ref(video),
      backgroundAudioRef: ref({ currentTime: 50 }), audioOnlyRef: ref(true),
      nativeBackgroundRef: ref(background), continueBackgroundAudioRef: ref(false),
      controlsVisibleRef: ref(false), queue: [], imageSeconds: 5, pip, Date, crypto: { randomUUID: () => 'test' },
      beginPlaybackTrace: () => ({ id: 'test', startedAt: Date.now() }),
      detailsMediaPath: (item) => item.path, getSessionUser: () => ({ id: 1 }),
      readLocalWatchProgress: () => ({}), restorePlaybackSession: () => ({}),
      selectPlaybackItem: () => ({}), watchDetailsFromItem: (item) => item,
      watchParamsFromItem: () => new URLSearchParams(),
    });
    // Supply unrelated player reset state so this exercises the real transition.
    for (const match of source.slice(source.indexOf('  const goToQueueItem ='), source.indexOf('  const reorderQueue =')).matchAll(/\b(\w+Ref)\.current/g)) {
      context[match[1]] ??= ref(null);
    }
    context.autoSkippedRef = ref(new Set());
    context.preparedVideoRef = ref({ slot: 1, src: '/two' });
    context.videoSlotsRef = ref([video, { readyState: ready ? 3 : 0 }]);
    for (const match of source.slice(source.indexOf('  const goToQueueItem ='), source.indexOf('  const reorderQueue =')).matchAll(/\b(set\w+|saveProgress|sendPlaybackActivity|stopActiveTranscode|updateLoadingTarget|closePopups|reportClientPerformance|replaceWatchLocation)\(/g)) {
      context[match[1]] = () => {};
    }
    let promoted = null;
    context.setActiveVideoSlot = slot => { promoted = slot; };
    context.stopBackgroundAudio = () => {
      context.backgroundAudioRef.current = null;
      context.audioOnlyRef.current = false;
      context.continueBackgroundAudioRef.current = false;
    };
    load(context, 'goToQueueItem')({ kind: 'video', src: '/two', path: 'two' }, true);
    assert.equal(context.backgroundAudioRef.current, null);
    assert.equal(context.continueBackgroundAudioRef.current, true);
    assert.equal(context.shouldPlayRef.current, true);
    assert.equal(promoted, ready && !pip ? 1 : null);
  }
});

test('background next starts audio directly, while normal video and audio resume still play normally', () => {
  for (const [continuing, background] of [[true, false], [false, true], [false, false]]) {
    let audioStarts = 0;
    let mediaStarts = 0;
    const video = {};
    const context = vm.createContext({
      videoRef: ref(video), backgroundAudioRef: ref(null),
      continueBackgroundAudioRef: ref(continuing), nativeBackgroundRef: ref(background),
      useCallback: handler => handler,
      backgroundAudioCallbacksRef: ref({ start: async () => { audioStarts++; } }),
      playMediaSafely: () => { mediaStarts++; }, setPlaybackError() {},
    });
    const play = load(context, 'playSafely');
    play(video);
    assert.equal(audioStarts, continuing || background ? 1 : 0);
    assert.equal(mediaStarts, continuing || background ? 0 : 1);
    context.backgroundAudioRef.current = {};
    play(context.backgroundAudioRef.current);
    assert.equal(mediaStarts, continuing || background ? 1 : 2);
  }
});

test('audio completion reads the current queue and ignores disposed players', () => {
  const audio = {};
  const events = [];
  const context = vm.createContext({
    useEffectEvent: (handler) => handler, backgroundAudioRef: ref(audio),
    handlePlaybackEnded: () => events.push('old'),
  });
  const ended = load(context, 'onBackgroundAudioEnded');
  context.handlePlaybackEnded = () => events.push('current');
  ended(audio);
  ended({});
  assert.deepEqual(events, ['current']);
});

test('natural audio end does not start background-pause recovery before auto-next', () => {
  let restarts = 0;
  const listeners = {};
  const audio = { ended: true, addEventListener: (name, handler) => { listeners[name] = handler; } };
  const context = vm.createContext({
    backgroundAudioRef: ref(audio), nativeBackgroundRef: ref(true), shouldPlayRef: ref(true),
    backgroundAudioCallbacksRef: ref(null),
    document: { visibilityState: 'hidden' }, setPlaying() {},
    restartBackgroundAudioAfterHide: () => { restarts++; },
  });
  load(context, 'watchBackgroundAudio')(audio);
  listeners.pause();
  assert.equal(restarts, 0);
  audio.ended = false;
  listeners.pause();
  assert.equal(restarts, 1);
});

test('buffering hides the position until startup has applied the resume point', () => {
  const run = (pending, busy) => {
    const calls = { target: [], withoutPosition: [] };
    const context = vm.createContext({
      playbackStartupPending: () => pending,
      qualityBusyRef: ref(busy), loadingTargetRef: ref(null), streamOffsetRef: ref(600),
      setBufferingWithoutPosition: (value) => calls.withoutPosition.push(value),
      updateLoadingTarget: (value) => calls.target.push(value),
    });
    load(context, 'markBuffering')({ currentTime: 5 });
    return calls;
  };
  assert.deepEqual(run(true, false), { target: [], withoutPosition: [true] });
  assert.deepEqual(run(false, true), { target: [], withoutPosition: [true] });
  assert.deepEqual(run(false, false), { target: [605], withoutPosition: [] });
});
