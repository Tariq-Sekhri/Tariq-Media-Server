const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { load } = require('./load-ts.cjs');
const { preferredAudioTrack, preloadSegments, cachedFragmentLoader, canDirectPlayVideo, willStreamCopyVideo } = load('app/lib/episode-preload.ts', { performance });

const watchSource = fs.readFileSync('app/watch/page.tsx', 'utf8');
const watchAst = ts.createSourceFile('watch.tsx', watchSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const ref = (current) => ({ current });
const flushMicrotasks = async () => {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
};
function loadWatchDecl(context, name) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(watchAst) === name) {
      initializer = node.initializer.getText(watchAst);
    }
    ts.forEachChild(node, visit);
  }
  visit(watchAst);
  assert.ok(initializer, name);
  return vm.runInContext(ts.transpile(`(${initializer})`, { target: ts.ScriptTarget.ES2022 }), context);
}
function findPreloadEffectCall() {
  let match = null;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(watchAst) === 'useEffect') {
      const bodyText = node.arguments[0]?.getText(watchAst) ?? '';
      if (bodyText.includes('preloadSegments(') && bodyText.includes('nextPreloadRef.current')) {
        match = node;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(watchAst);
  assert.ok(match, 'next-episode preload useEffect');
  return match;
}

test('English is preferred over Japanese default; language follows reordered episode streams', () => {
  const ja = { stream_index: 1, language: 'jpn', is_default: true };
  const en = { stream_index: 2, language: 'eng', is_default: false };
  assert.equal(preferredAudioTrack([ja, en]).stream_index, 2);
  assert.equal(preferredAudioTrack([{ ...en, stream_index: 5 }, { ...ja, stream_index: 8 }], 'English').stream_index, 5);
  assert.equal(preferredAudioTrack([en, ja], 'ja').stream_index, 1);
  assert.equal(preferredAudioTrack([{ ...en, language: 'en-US' }, ja]).stream_index, 2);
  assert.equal(preferredAudioTrack([ja]).stream_index, 1);
  assert.equal(preferredAudioTrack([]), undefined);
});

test('prefix downloads stop at ten seconds and resolve relative segment URLs', () => {
  const playlist = '#EXTM3U\n' + Array.from({ length: 50 }, (_, i) => `#EXTINF:2.0,\nsegment_${i}.ts`).join('\n');
  assert.deepEqual(Array.from(preloadSegments(playlist, 'http://localhost/transcodes/key/stream.m3u8')), Array.from({ length: 5 }, (_, i) => `http://localhost/transcodes/key/segment_${i}.ts`));
  assert.equal(preloadSegments('#EXTM3U\n#EXTINF:NaN,\nbad.ts', 'http://localhost/a.m3u8').length, 0);
});

test('HLS receives cached bytes without a network request or transferring the retained buffer', () => {
  let network = 0;
  class BaseLoader {
    constructor() { this.stats = { loading: {} }; }
    load() { network++; }
  }
  const retained = new Uint8Array([1, 2, 3]).buffer;
  const Cached = cachedFragmentLoader(BaseLoader, new Map([['http://localhost/segment.ts', retained]]));
  const loader = new Cached({});
  let received;
  loader.load({ url: 'http://localhost/segment.ts' }, {}, { onSuccess: result => { received = result.data; } });
  assert.equal(network, 0);
  assert.notEqual(received, retained);
  assert.deepEqual([...new Uint8Array(received)], [1, 2, 3]);
  new Uint8Array(received)[0] = 9;
  assert.equal(new Uint8Array(retained)[0], 1);
  loader.load({ url: 'http://localhost/other.ts' }, {}, {});
  loader.load({ url: 'http://localhost/segment.ts', rangeStart: 1 }, {}, {});
  assert.equal(network, 2);
});


test('direct playback checks video codec and HEVC Main 10 independently of AAC audio', () => {
  const info = { video_codec: 'hevc', video_profile: 'Main 10', audio_compatible: true };
  let probed;
  assert.equal(canDirectPlayVideo(info, { canPlayType: mime => { probed = mime; return ''; } }), false);
  assert.equal(probed, 'video/mp4; codecs="hvc1.2.4.L153.B0"');
  assert.equal(canDirectPlayVideo(info, { canPlayType: () => 'probably' }), true);
  assert.equal(canDirectPlayVideo({ ...info, video_profile: 'Main' }, { canPlayType: mime => { probed = mime; return 'probably'; } }), true);
  assert.equal(probed, 'video/mp4; codecs="hvc1.1.6.L153.B0"');
  assert.equal(canDirectPlayVideo({ video_codec: 'h264' }, { canPlayType: () => 'probably' }), true);
  assert.equal(canDirectPlayVideo({ video_codec: 'mpeg2video' }, { canPlayType: () => 'probably' }), false);
  assert.equal(canDirectPlayVideo({}, { canPlayType: () => '' }), true);
});

test('willStreamCopyVideo matches 8-bit H.264 without burned subtitles when supported', () => {
  const supported = { canPlayType: () => 'probably' };
  const unsupported = { canPlayType: () => '' };
  assert.equal(willStreamCopyVideo({ video_codec: 'h264', video_profile: 'High' }, supported, null), true);
  assert.equal(willStreamCopyVideo({ video_codec: 'h264', video_profile: 'High 10' }, supported, null), false);
  assert.equal(willStreamCopyVideo({ video_codec: 'h264', video_profile: 'High' }, supported, 3), false);
  assert.equal(willStreamCopyVideo({ video_codec: 'hevc', video_profile: 'Main' }, supported, null), false);
  assert.equal(willStreamCopyVideo({ video_codec: 'vp9', video_profile: 'Profile 0' }, supported, null), false);
  assert.equal(willStreamCopyVideo({ video_codec: 'h264', video_profile: 'High' }, unsupported, null), false);
});

test('next-episode preload effect stays stable across pause/resume, skips copy-video transcode preload, and handles 204', async () => {
  const effectCall = findPreloadEffectCall();
  const deps = effectCall.arguments[1];
  assert.ok(ts.isArrayLiteralExpression(deps), 'preload useEffect must have dependency array');
  assert.equal(deps.elements.some((el) => el.getText(watchAst) === 'playing'), false, 'preload effect must not depend on playing');

  const compiled = ts.transpileModule(`(${effectCall.arguments[0].getText(watchAst)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const runEffect = async ({ info, transcodeStatus = 200, playlistText = '', segments = {}, initialFragments = [] }) => {
    const fetchedUrls = [];
    const preloadedFragmentsRef = ref(new Map(initialFragments));
    const nextPreloadRef = ref(null);
    const context = vm.createContext({
      details: { kind: 'video', offline: false, src: '/media/Shows/ep1.mkv', path: 'Shows/ep1.mkv' },
      nextQueueItem: { kind: 'video', offline: false, src: '/media/Shows/ep2.mkv', path: 'Shows/ep2.mkv' },
      audioTracks: [{ stream_index: 1, language: 'eng', is_default: true }],
      selectedAudioStream: 1,
      audioLanguageRef: ref('en'),
      quality: 'original-aac',
      burnedSubtitleStream: null,
      tracks: [],
      activeVideoSlot: 0,
      qualityBusyRef: ref(false),
      videoRef: ref({ paused: false, currentTime: 10, duration: 1200, canPlayType: () => 'probably' }),
      videoInfoCacheRef: ref(new Map()),
      nextUserStateRef: ref(null),
      nextPreloadRef,
      preloadedFragmentsRef,
      activeTranscodeSessionRef: ref('active-session'),
      detailsRef: ref({ kind: 'video', src: '/media/Shows/ep1.mkv', path: 'Shows/ep1.mkv' }),
      API_BASE: '',
      URL,
      URLSearchParams,
      AbortController,
      window: { location: { href: 'http://localhost:3000/watch' } },
      Math,
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout() {},
      setInterval: () => 2,
      clearInterval() {},
      detailsMediaPath: (d) => d.path,
      timeIsBuffered: () => true,
      rememberQueueDuration() {},
      preferredAudioTrack,
      canDirectPlayVideo,
      willStreamCopyVideo,
      canBufferQueueVideo: () => false,
      setPreparedVideo() {},
      createTranscodeSessionId: () => 'preload-session',
      playbackUserStateUrl: () => '/api/user-state',
      getSessionUser: () => ({ id: 1 }),
      mergeWatchProgress: () => ({}),
      readLocalWatchProgress: () => ({}),
      preloadSegments,
      reportClientPerformance() {},
      cancelTranscodeSession() {},
      fetch: async (url) => {
        const key = String(url);
        fetchedUrls.push(key);
        if (key.startsWith('/api/qualities')) return { ok: true, status: 200, json: async () => info };
        if (key.startsWith('/api/transcode')) {
          if (transcodeStatus === 204) return { ok: true, status: 204 };
          return { ok: true, status: 200, json: async () => ({ url: '/transcodes/k/stream.m3u8' }) };
        }
        if (key.endsWith('/stream.m3u8')) return { ok: true, status: 200, text: async () => playlistText };
        if (segments[key]) return { ok: true, status: 200, arrayBuffer: async () => segments[key] };
        throw new Error(`Unexpected fetch: ${key}`);
      },
      authFetch: async (url) => {
        fetchedUrls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ playback: {} }) };
      },
    });
    const cleanup = vm.runInContext(compiled, context)();
    await flushMicrotasks();
    return { fetchedUrls, preloadedFragmentsRef, nextPreloadRef, context, cleanup };
  };

  // 1. Stream-copied 8-bit H.264 prewarms qualities + user-state without /api/transcode preload.
  const h264Run = await runEffect({
    info: {
      source_height: 1080,
      video_codec: 'h264',
      video_profile: 'High',
      audio_compatible: true,
      audio_tracks: [{ stream_index: 1, language: 'jpn', is_default: true }, { stream_index: 2, language: 'eng', is_default: false }],
    },
  });
  assert.ok(h264Run.fetchedUrls.some((u) => u.startsWith('/api/qualities')));
  assert.ok(h264Run.fetchedUrls.includes('/api/user-state'));
  assert.equal(h264Run.fetchedUrls.some((u) => u.startsWith('/api/transcode')), false);
  assert.equal(h264Run.nextPreloadRef.current, null);
  h264Run.cleanup();

  // 2. 204 response clears nextPreloadRef and preserves existing fragments until real preload succeeds.
  const noContentRun = await runEffect({
    info: {
      source_height: 1080,
      video_codec: 'hevc',
      video_profile: 'Main 10',
      audio_compatible: false,
      audio_tracks: [{ stream_index: 1, language: 'jpn', is_default: true }, { stream_index: 2, language: 'eng', is_default: false }],
    },
    transcodeStatus: 204,
    initialFragments: [['http://localhost:3000/prev.ts', new Uint8Array([9]).buffer]],
  });
  assert.equal(noContentRun.nextPreloadRef.current, null);
  assert.equal(noContentRun.preloadedFragmentsRef.current.has('http://localhost:3000/prev.ts'), true);
  noContentRun.cleanup();

  // 3. Re-encoded HEVC next episode preloads segment bytes cleanly.
  const segBytes = new Uint8Array([7, 8, 9]).buffer;
  const hevcRun = await runEffect({
    info: {
      source_height: 1080,
      video_codec: 'hevc',
      video_profile: 'Main 10',
      audio_compatible: false,
      audio_tracks: [{ stream_index: 1, language: 'jpn', is_default: true }, { stream_index: 2, language: 'eng', is_default: false }],
    },
    transcodeStatus: 200,
    playlistText: '#EXTM3U\n#EXTINF:2.0,\nsegment_00000.ts\n',
    segments: { 'http://localhost:3000/transcodes/k/segment_00000.ts': segBytes },
  });
  assert.equal(hevcRun.preloadedFragmentsRef.current.get('http://localhost:3000/transcodes/k/segment_00000.ts'), segBytes);
  hevcRun.cleanup();
});

test('changeQuality clears stale preloaded fragments, retries recoverable HLS errors, falls back from copy_video, and cancels unrecoverable transcodes', async () => {
  const createdHls = [];
  const transcodeCalls = [];
  const cancelledSessions = [];
  let stopActiveCount = 0;
  let playingState = true;
  let playbackError = '';
  let sessionSeq = 0;
  const removedAttrs = [];

  class MockHls {
    static Events = { LEVEL_SWITCHED: 'levelSwitched', FRAG_BUFFERED: 'fragBuffered', MANIFEST_PARSED: 'manifestParsed', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static DefaultConfig = { loader: class {} };
    static isSupported() { return true; }
    constructor(config) {
      this.config = config;
      this.handlers = new Map();
      this.startLoadCalls = 0;
      this.recoverCalls = 0;
      this.destroyed = false;
      createdHls.push(this);
    }
    loadSource(url) { this.url = url; }
    attachMedia() {}
    on(event, fn) { this.handlers.set(event, fn); }
    startLoad() { this.startLoadCalls += 1; }
    recoverMediaError() { this.recoverCalls += 1; }
    destroy() { this.destroyed = true; }
    emit(event, data) { this.handlers.get(event)?.(event, data); }
  }

  const video = {
    paused: false,
    currentTime: 0,
    readyState: 0,
    pause() { this.paused = true; },
    removeAttribute(name) { removedAttrs.push(name); },
    load() {},
    addEventListener() {},
  };
  const preloadedFragmentsRef = ref(new Map([['http://localhost:3000/stale.ts', new Uint8Array([1]).buffer]]));
  const context = vm.createContext({
    details: { kind: 'video', offline: false, src: '/media/Shows/ep1.mkv', path: 'Shows/ep1.mkv', name: 'Episode 1' },
    videoRef: ref(video),
    selectedAudioStream: 2,
    burnedSubtitleStream: null,
    directPlaybackCompatibleRef: ref(true),
    videoCopyableRef: ref(true),
    audioTracks: [{ stream_index: 1, language: 'jpn', is_default: true }, { stream_index: 2, language: 'eng', is_default: false }],
    sourceHeightRef: ref(1080),
    sourceHeight: 1080,
    qualityLevels: [720],
    qualityBusyRef: ref(false),
    quality: 'original',
    qualityRequestRef: ref(0),
    currentTime: 92,
    playbackPreferences: { buffer_size_mb: 500 },
    shouldPlayRef: ref(true),
    activeTranscodeSessionRef: ref(null),
    nextPreloadRef: ref(null),
    preloadedFragmentsRef,
    hlsRef: ref(null),
    streamOffsetRef: ref(0),
    API_BASE: '',
    Hls: MockHls,
    setTimeout: () => 0,
    detailsMediaPath: (d) => d.path,
    createTranscodeSessionId: () => `sess-${++sessionSeq}`,
    cachedFragmentLoader,
    transcodeBufferSeconds: () => 60,
    reportClientPerformance() {},
    playSafely() {},
    setQualityMenuOpen() {},
    setQualityBusy() {},
    setQuality() {},
    setResolvedQuality() {},
    setPlaying(value) { playingState = value; },
    setPlaybackError(value) { playbackError = value; },
    cancelTranscodeSession(session) { cancelledSessions.push(session); },
    stopActiveTranscode() {
      stopActiveCount += 1;
      const active = context.activeTranscodeSessionRef.current;
      context.activeTranscodeSessionRef.current = null;
      if (active) cancelledSessions.push(active);
    },
    fetch: async (url) => {
      transcodeCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ url: '/transcodes/k/stream.m3u8', offset: 91, session: `sess-${sessionSeq}` }) };
    },
  });
  const changeQuality = loadWatchDecl(context, 'changeQuality');
  context.changeQuality = changeQuality;

  await changeQuality('original', 92, true, true);
  assert.equal(preloadedFragmentsRef.current.size, 0, 'non-warm start clears stale fragments');
  assert.equal(transcodeCalls.length, 1);
  assert.match(transcodeCalls[0], /copy_video=true/);
  assert.equal(createdHls.length, 1);

  const first = createdHls[0];
  first.emit(MockHls.Events.ERROR, { fatal: true, type: MockHls.ErrorTypes.NETWORK_ERROR });
  assert.equal(first.startLoadCalls, 1);
  assert.equal(first.destroyed, false);

  first.emit(MockHls.Events.ERROR, { fatal: true, type: MockHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(first.recoverCalls, 1);
  assert.equal(first.destroyed, false);

  // Second fatal media error falls back from copy_video to accurate re-encode.
  first.emit(MockHls.Events.ERROR, { fatal: true, type: MockHls.ErrorTypes.MEDIA_ERROR });
  await flushMicrotasks();
  assert.equal(first.destroyed, true);
  assert.equal(transcodeCalls.length, 2);
  assert.doesNotMatch(transcodeCalls[1], /copy_video=true/);
  assert.equal(createdHls.length, 2);

  // Unrecoverable fatal errors on the re-encoded fallback cancel transcode and clean state.
  removedAttrs.length = 0;
  const fallback = createdHls[1];
  fallback.emit(MockHls.Events.ERROR, { fatal: true, type: MockHls.ErrorTypes.MEDIA_ERROR });
  fallback.emit(MockHls.Events.ERROR, { fatal: true, type: MockHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(fallback.recoverCalls, 1);
  assert.equal(fallback.destroyed, true);
  assert.ok(stopActiveCount >= 2);
  assert.ok(cancelledSessions.includes('sess-2'));
  assert.equal(context.shouldPlayRef.current, false);
  assert.equal(playingState, false);
  assert.deepEqual(removedAttrs, ['src']);
  assert.match(playbackError, /failed/);
});

test('resumePlayback restarts a torn-down HLS player via changeQuality instead of playing a src-less video', () => {
  const makeContext = ({ hls = null, attrSrc = null } = {}) => {
    const calls = { playSafely: 0, changeQuality: [] };
    const video = { paused: true, getAttribute: (name) => (name === 'src' ? attrSrc : null) };
    const context = vm.createContext({
      details: { kind: 'video', offline: false },
      backgroundAudioRef: ref(null),
      videoRef: ref(video),
      qualityBusyRef: ref(false),
      shouldPlayRef: ref(false),
      quality: 'original-aac',
      hlsRef: ref(hls),
      currentTime: 95.4,
      announcePlayback() {},
      setPlaying() {},
      setPlaybackError() {},
      playbackStartupPending: () => false,
      playSafely() { calls.playSafely += 1; },
      changeQuality(...args) { calls.changeQuality.push(args); },
    });
    return { calls, resumePlayback: loadWatchDecl(context, 'resumePlayback') };
  };

  const tornDown = makeContext({ hls: null, attrSrc: null });
  tornDown.resumePlayback();
  assert.deepEqual(tornDown.calls.changeQuality, [['original-aac', 95.4, true, true]]);
  assert.equal(tornDown.calls.playSafely, 0);

  const healthy = makeContext({ hls: {}, attrSrc: null });
  healthy.resumePlayback();
  assert.equal(healthy.calls.playSafely, 1);
  assert.equal(healthy.calls.changeQuality.length, 0);
});
