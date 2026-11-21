const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');

const track = name => ({ kind: 'audio', src: '/media/' + name + '.mp3' });
const trackNames = entries => entries.map(item => new URL(item.src).pathname);

function harness() {
  const sounds = [];
  const timers = new Map();
  let id = 0;
  const document = {
    body: { append() {} },
    createElement(tag) {
      const events = new Map();
      const element = { dataset: {}, currentTime: 0, duration: 30, readyState: 0, paused: true,
        append() {}, remove() {},
        addEventListener(name, callback) { events.set(name, callback); },
        removeEventListener(name) { events.delete(name); },
        emit(name) { events.get(name)?.(); },
        removeAttribute(name) { delete this[name]; },
        load() { this.released = true; },
      };
      if (tag === 'audio') sounds.push(element);
      return element;
    },
  };
  const window = {
    location: new URL('https://example.test'),
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
  };
  const navigator = { connection: {} };
  const preload = load('app/lib/audio-preload.ts', { window, document, navigator });
  const publish = (names, resume = () => 0, owner = 1) => preload.setViewportAudio(names.map(track), owner, resume);
  function buffer(audio, start, end) {
    audio.readyState = 3;
    audio.buffered = { length: 1, start: () => start, end: () => end };
    audio.emit('progress');
  }
  return { ...preload, publish, buffer, sounds, timers, navigator };
}

test('the viewport queues all tracks, with two active loads until a second is ready', () => {
  const p = harness();
  p.publish(['one', 'two', 'three', 'four']);
  assert.deepEqual(trackNames(p.sounds), ['/media/one.mp3', '/media/two.mp3']);
  p.buffer(p.sounds[0], 0, 0.5);
  assert.equal(p.sounds.length, 2);
  p.buffer(p.sounds[0], 0, 1);
  p.buffer(p.sounds[1], 0, 1);
  assert.deepEqual(trackNames(p.sounds), ['/media/one.mp3', '/media/two.mp3', '/media/three.mp3', '/media/four.mp3']);
  assert.equal(p.sounds[0].preload, 'metadata');
});

test('scroll cancels out-of-view work and a tap reuses its element and yields other requests', () => {
  const p = harness();
  p.publish(['one', 'two', 'three']);
  p.publish(['two', 'three', 'four']);
  assert.equal(p.sounds[0].released, true);
  assert.equal(p.takePreparedAudio('/media/three.mp3', 1), p.sounds[2]);
  assert.equal(p.sounds[1].released, true);
  assert.equal(p.sounds[2].released, undefined);
  assert.equal(p.sounds.length, 3);
  const resume = [...p.timers.entries()].find(([, timer]) => timer.delay === 750);
  p.timers.delete(resume[0]);
  resume[1].fn();
  assert.deepEqual(trackNames(p.sounds.slice(3)), ['/media/two.mp3', '/media/four.mp3']);
});

test('loading starts around the saved position and is discarded when the owner changes', () => {
  const p = harness();
  p.publish(['one'], () => 12);
  p.buffer(p.sounds[0], 0, 1);
  assert.equal(p.sounds[0].currentTime, 12);
  p.sounds[0].emit('suspend');
  assert.equal(p.sounds[0].preload, 'auto');
  p.buffer(p.sounds[0], 11, 13);
  assert.equal(p.sounds[0].preload, 'metadata');
  p.publish(['one'], () => 0, 2);
  assert.equal(p.sounds[0].released, true);
  assert.equal(p.takePreparedAudio('/media/one.mp3', 2), p.sounds[1]);
});

test('data saver and downloads skip speculative requests', () => {
  const p = harness();
  p.setViewportAudio([{ ...track('download'), offline: {} }], 1, () => 0);
  p.navigator.connection.saveData = true;
  p.publish(['stream']);
  assert.equal(p.sounds.length, 0);
});

test('priming delay at the start of buffered audio still counts as ready for the next track', () => {
  const p = harness();
  p.publish(['one', 'two', 'three']);
  assert.deepEqual(trackNames(p.sounds), ['/media/one.mp3', '/media/two.mp3']);
  p.buffer(p.sounds[0], 0.04, 1.02);
  assert.equal(p.sounds[0].preload, 'metadata');
  assert.deepEqual(trackNames(p.sounds), ['/media/one.mp3', '/media/two.mp3', '/media/three.mp3']);
});
