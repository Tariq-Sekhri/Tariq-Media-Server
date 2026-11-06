const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual handoff with controllable media readiness/play promises.
const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
const functionSource = (name, next) => source.slice(source.indexOf(`  const ${name} =`), source.indexOf(`  const ${next} =`));
const ref = (current) => ({ current });
function harness({ hls = false, playing = true } = {}) {
  const elements = [];
  const video = { currentSrc: 'movie.mp4', src: 'movie.mp4', currentTime: 42, volume: 0.7, muted: false, playbackRate: 1.25, pause() { this.paused = true; } };
  let exits = 0;
  class FakeHls {
    static isSupported() { return true; }
    loadSource(url) { this.url = url; }
    attachMedia(audio) { audio.hls = this; }
    destroy() { this.destroyed = true; }
  }
  const context = {
    videoRef: ref(video), backgroundAudioRef: ref(null), backgroundAudioHlsRef: ref(null),
    backgroundAudioStartingRef: ref(false), backgroundAudioGenerationRef: ref(0),
    backgroundAudioRestartingRef: ref(false),
    continueBackgroundAudioRef: ref(false), qualityBusyRef: ref(false),
    useLayoutEffect() {}, backgroundAudioCallbacksRef: ref(null), playbackStartupPending: () => false,
    nativeBackgroundRef: ref(true), shouldPlayRef: ref(playing), audioOnlyRef: ref(false),
    backgroundAudioHandoffAtRef: ref(0), streamOffsetRef: ref(0), details: { kind: 'video' },
    hlsRef: ref(hls ? { url: 'movie.m3u8' } : null), Hls: FakeHls,
    setAudioOnly() {}, setPlaying() {}, setCurrentTime() {}, setMediaSessionSyncId() {}, setPlaybackError() {}, watchBackgroundAudio() {},
    playSafely(media) { media.paused = false; },
    applyMediaVolume(media, volume) { media.volume = volume; }, readMediaVolumePosition(media) { return media.volume; },
    releaseMediaVolume() {}, resumeMediaVolume() {},
    exitNativePip: async () => { exits++; },
    document: {
      body: { appendChild() {} },
      createElement() {
        const listeners = {};
        const audio = {
          addEventListener(event, listener) { listeners[event] = listener; },
          ready() { listeners.loadedmetadata(); },
          async play() { this.playCalls = (this.playCalls || 0) + 1; if (this.waitForPlay) await this.waitForPlay; this.paused = false; },
          pause() { this.paused = true; }, removeAttribute() {}, load() {}, remove() { this.removed = true; },
        };
        elements.push(audio);
        return audio;
      },
    },
    window: { setTimeout, clearTimeout }, console,
  };
  vm.createContext(context);
  const code = functionSource('stopBackgroundAudio', 'restoreVideoLatest') + functionSource('restartBackgroundAudioAfterHide', 'startBackgroundAudio') + functionSource('startBackgroundAudio', 'startBackgroundAudioLatest');
  vm.runInContext(ts.transpileModule(code + '\nglobalThis.start = startBackgroundAudio; globalThis.restore = restoreVideoFromBackgroundAudio; globalThis.restart = restartBackgroundAudioAfterHide;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, video, elements, exits: () => exits };
}

for (const hls of [false, true]) {
  test(`next ${hls ? 'HLS' : 'direct'} video can start audio without a video play event`, async () => {
    const h = harness();
    h.context.nativeBackgroundRef.current = false;
    h.context.continueBackgroundAudioRef.current = true;
    h.context.hlsRef.current = hls ? { url: 'next.m3u8' } : null;
    h.video.paused = true;
    h.video.currentTime = 0;
    const pending = h.context.start(true);
    h.elements[0].ready();
    await pending;
    assert.equal(h.context.backgroundAudioRef.current, h.elements[0]);
    assert.equal(h.elements[0].paused, false);
    assert.equal(h.video.paused, true);
    assert.equal(h.elements[0].currentTime, 0);
    if (hls) assert.equal(h.elements[0].hls.url, 'next.m3u8');
  });

  test(`screen lock automatically hands off ${hls ? 'HLS' : 'direct video'} and restores its position`, async () => {
    const h = harness({ hls });
    const pending = h.context.start(true);
    await h.context.start(true); // duplicate lifecycle event
    assert.equal(h.elements.length, 1);
    h.video.currentTime = 43;
    h.elements[0].ready();
    await pending;
    const audio = h.context.backgroundAudioRef.current;
    assert.equal(audio.currentTime, 43);
    assert.equal(audio.volume, 0.7);
    assert.equal(audio.playbackRate, 1.25);
    assert.equal(h.video.paused, true);
    assert.equal(h.exits(), 0); // automatic handoff never dismisses PiP
    if (hls) assert.equal(audio.hls.url, 'movie.m3u8');
    audio.currentTime = 58;
    h.context.restore();
    assert.equal(h.video.currentTime, 58);
    assert.equal(h.video.paused, false);
    assert.equal(audio.removed, true);
  });
}

test('locking a paused video leaves it paused', async () => {
  const h = harness({ playing: false });
  await h.context.start(true);
  assert.equal(h.elements.length, 0);
});

for (const action of ['unlock', 'pause', 'episode change']) {
  test(`${action} during audio loading cancels the pending handoff`, async () => {
    const h = harness();
    const pending = h.context.start(true);
    if (action === 'unlock') { h.context.nativeBackgroundRef.current = false; h.context.restore(); }
    if (action === 'pause') h.context.shouldPlayRef.current = false;
    if (action === 'episode change') h.video.currentSrc = 'next.mp4';
    h.elements[0].ready();
    await pending;
    assert.equal(h.context.backgroundAudioRef.current, null);
    assert.equal(h.elements[0].playCalls, undefined);
    assert.equal(h.elements[0].removed, true);
  });
}

test('a pause while audio.play is pending cannot restart playback', async () => {
  const h = harness();
  const pending = h.context.start(true);
  let finishPlay;
  h.elements[0].waitForPlay = new Promise(resolve => { finishPlay = resolve; });
  h.elements[0].ready();
  await Promise.resolve();
  h.context.shouldPlayRef.current = false;
  finishPlay();
  await pending;
  assert.equal(h.elements[0].paused, true);
  assert.equal(h.context.backgroundAudioRef.current, null);
});

test('returning from the background respects an explicit pause', async () => {
  const h = harness();
  const pending = h.context.start(true);
  h.elements[0].ready();
  await pending;
  h.context.shouldPlayRef.current = false;
  h.elements[0].pause();
  h.context.restore();
  assert.equal(h.video.paused, true);
});

test('unlocking during a background recovery cannot create an orphan player', async () => {
  const h = harness();
  const start = h.context.start(true);
  h.elements[0].ready();
  await start;
  h.elements[0].pause();
  const restart = h.context.restart();
  let finishPlay;
  h.elements[1].waitForPlay = new Promise(resolve => { finishPlay = resolve; });
  h.elements[1].ready();
  await Promise.resolve();
  h.context.restore();
  finishPlay();
  await restart;
  assert.equal(h.context.backgroundAudioRef.current, null);
  assert.equal(h.elements[0].removed, true);
  assert.equal(h.elements[1].paused, true);
  assert.equal(h.elements[1].removed, true);
  assert.equal(h.video.paused, false);
});

test('the Android WebView stays visible to Chromium while media is playing', () => {
  // Screen lock / leaving the app hides the window; Chromium then pauses video
  // and throttles the page, which stopped playback and broke the audio handoff.
  const layout = fs.readFileSync('android/app/src/main/res/layout/capacitor_bridge_layout_main.xml', 'utf8');
  assert.match(layout, /<ca\.sekhrit\.tms\.TmsWebView[\s\S]*android:id="@\+id\/webview"/);
  const webView = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/TmsWebView.java', 'utf8');
  assert.match(webView, /extends CapacitorWebView/);
  assert.match(webView, /onWindowVisibilityChanged\(int visibility\) \{[\s\S]*?MainActivity\.isMediaPlaying\(\)[\s\S]*?super\.onWindowVisibilityChanged\(View\.VISIBLE\)/);
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  assert.match(activity, /static boolean isMediaPlaying\(\) \{\s*return activeInstance != null && activeInstance\.pipPlaying;/);
  assert.match(activity, /volatile boolean pipPlaying/);
});

test('the web player reports playing state to Android for audio-only playback too', () => {
  assert.match(source, /syncNativePipState\(\{[\s\S]*?playing,\s*hasNext/);
});
