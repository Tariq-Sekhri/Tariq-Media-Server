const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
function harness({ visible = false, preserved = false, intent = true, startup = false, busy = false } = {}) {
  const context = {
    controlsVisibleRef: { current: visible }, preserveHiddenControlsRef: { current: preserved },
    shouldPlayRef: { current: intent }, qualityBusyRef: { current: busy },
    nativeBackgroundRef: { current: false }, audioOnlyRef: { current: false },
    streamOffsetRef: { current: 0 }, document: { visibilityState: 'visible' },
    resumeMediaVolume() {}, setPlaying() {}, nativePipAvailable: () => false,
    playbackStartupPending: () => startup, reportPlayback() {}, saveProgress() {},
    reveals: 0,
    showControls() { context.reveals++; context.controlsVisibleRef.current = true; context.preserveHiddenControlsRef.current = false; },
    setControlsVisible(value) { if (value) context.reveals++; context.controlsVisibleRef.current = value; },
  };
  vm.createContext(context);
  for (const name of ['onPlay', 'onPause']) {
    const body = source.match(new RegExp(`${name}=\\{\\(event\\) => \\{([\\s\\S]*?)\\n        \\}\\}`))[1];
    context[name] = vm.runInContext(`(event) => {${body}}`, context);
  }
  const event = { currentTarget: { currentTime: 10, ended: false } };
  return { context, play: () => context.onPlay(event), pause: (ended = false) => context.onPause({ currentTarget: { ...event.currentTarget, ended } }) };
}

test('end-of-video pause cannot reveal hidden controls before auto-next', () => {
  const h = harness();
  h.pause(true);
  h.play();
  assert.equal(h.context.reveals, 0);
});

test('hidden queue controls survive repeated play and pause events across media swaps', () => {
  const h = harness({ preserved: true });
  for (let i = 0; i < 3; i++) { h.pause(); h.play(); }
  assert.equal(h.context.reveals, 0);
  assert.equal(h.context.preserveHiddenControlsRef.current, true);
  h.context.showControls();
  assert.equal(h.context.controlsVisibleRef.current, true);
  assert.equal(h.context.preserveHiddenControlsRef.current, false);
});

test('startup and quality source swaps cannot reveal hidden controls', () => {
  for (const options of [{ startup: true, intent: false }, { busy: true, intent: false }, {}]) {
    const h = harness(options);
    h.pause(); h.play();
    assert.equal(h.context.reveals, 0);
  }
});

test('deliberate pause still reveals controls and visible playback refreshes them', () => {
  const h = harness({ intent: false });
  h.pause();
  assert.equal(h.context.reveals, 1);
  h.play();
  assert.equal(h.context.reveals, 2);
});
