const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, storage } = require('./load-ts.cjs');

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('audible range starts at -20 dB, keeps mute, and is reversible', () => {
  const media = load('app/lib/media.ts');
  close(media.volumeFromSlider(0.01), 0.1);
  close(media.sliderFromVolume(0.1), 0.01);
  close(media.sliderFromVolume(0.001), 0.01);
  assert.equal(media.volumeFromSlider(0), 0);
  assert.equal(media.volumeFromSlider(1), 1);
  assert.equal(media.volumeLabelFromSlider(0.01), '-20 dB');
  let previous = 0;
  for (let step = 1; step <= 100; step++) {
    const position = step / 100;
    const volume = media.volumeFromSlider(position);
    assert.ok(volume > previous);
    close(media.sliderFromVolume(volume), position);
    previous = volume;
  }
});

const oldQuietAmplitude = position => position === 0 ? 0 : 10 ** ((position <= 0.25 ? -80 + 40 * position / 0.25 : -40 * (1 - position) / 0.75) / 20);
const cappedAmplitude = volume => volume === 0 ? 0 : Math.min(10, Math.max(0.1, volume));

test('saved volume migrates once with the new audible floor for either old curve', () => {
  for (const curve of [null, '2']) {
    for (const position of [0, 0.1, 0.5, 0.75, 1]) {
      const localStorage = storage();
      localStorage.setItem('tms_volume', position);
      if (curve) localStorage.setItem('tms_volume_curve', curve);
      const media = load('app/lib/media.ts', { window: { localStorage } });
      const oldVolume = position === 0 ? 0 : 10 ** (((curve === '2' ? -80 : -24) * (1 - position)) / 20);
      const migrated = media.readStoredVolumePosition();
      close(media.volumeFromSlider(migrated), cappedAmplitude(oldVolume));
      assert.equal(localStorage.getItem('tms_volume_curve'), '6');
      assert.equal(media.readStoredVolumePosition(), migrated);
      assert.equal(load('app/lib/media.ts', { window: { localStorage } }).readStoredVolumePosition(), migrated);
    }
  }
});

test('boost is reversible and capped at +20 dB', () => {
  const media = load('app/lib/media.ts');
  for (let step = 100; step <= 200; step++) {
    const position = step / 100;
    close(media.volumeFromSlider(position), 10 ** (position - 1));
    close(media.sliderFromVolume(media.volumeFromSlider(position)), position);
  }
  assert.equal(media.VOLUME_SLIDER_MAX, 2);
  assert.equal(media.volumeFromSlider(2), 10);
  assert.equal(media.volumeFromSlider(4), 10);
  assert.equal(media.sliderFromVolume(200), 2);
  assert.equal(media.volumeLabelFromSlider(0), '\u2212\u221e dB');
  assert.equal(media.volumeLabelFromSlider(0.01), '-20 dB');
  assert.equal(media.volumeLabelFromSlider(1), '0 dB');
  assert.equal(media.volumeLabelFromSlider(1.25), '+5 dB');
  assert.equal(media.volumeLabelFromSlider(1.5), '+10 dB');
  assert.equal(media.volumeLabelFromSlider(2), '+20 dB');
});

test('previous boost settings preserve gain up to the new cap and migrate once', () => {
  for (const position of [0, 0.25, 1, 1.01, 1.1, 1.25, 1.5, 1.75, 2]) {
    const localStorage = storage();
    localStorage.setItem('tms_volume_curve', '4');
    localStorage.setItem('tms_volume', String(position));
    const media = load('app/lib/media.ts', { window: { localStorage } });
    const oldAmplitude = position > 1.5 ? 50 * 2 ** ((position - 1.5) * 2)
      : position > 1 ? 50 ** ((position - 1) * 2) : oldQuietAmplitude(position);
    const migrated = media.readStoredVolumePosition();
    close(media.volumeFromSlider(migrated), cappedAmplitude(oldAmplitude));
    assert.equal(localStorage.getItem('tms_volume_curve'), '6');
    assert.equal(media.readStoredVolumePosition(), migrated);
  }
});

test('saved linear boost migrates once into the supported range', () => {
  for (const position of [0, 0.25, 1, 1.5, 3]) {
    const localStorage = storage();
    localStorage.setItem('tms_volume_curve', '3');
    localStorage.setItem('tms_volume', String(position));
    const media = load('app/lib/media.ts', { window: { localStorage } });
    const migrated = media.readStoredVolumePosition();
    close(media.volumeFromSlider(migrated), cappedAmplitude(position > 1 ? position : oldQuietAmplitude(position)));
    assert.equal(localStorage.getItem('tms_volume_curve'), '6');
    assert.equal(media.readStoredVolumePosition(), migrated);
  }
});

test('boost uses gain while native volume stays valid, resets below 100, and reuses its graph', () => {
  let contexts = 0;
  let sources = 0;
  let resumed = 0;
  let closed = 0;
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  class AudioContext {
    state = 'suspended';
    constructor() { contexts++; }
    createGain() { return gain; }
    createMediaElementSource() { sources++; return { connect() {}, disconnect() {} }; }
    resume() { resumed++; this.state = 'running'; return Promise.resolve(); }
    close() { closed++; return Promise.resolve(); }
  }
  const media = load('app/lib/media.ts', { window: { AudioContext } });
  const element = { volume: 0.5, muted: false };
  assert.equal(media.applyMediaVolume(element, 1.5), 1.5);
  assert.equal(element.volume, 1);
  close(gain.gain.value, Math.sqrt(10));
  assert.equal(media.readMediaVolumePosition(element), 1.5);
  element.muted = true;
  assert.equal(media.readMediaVolumePosition(element), 1.5);
  media.applyMediaVolume(element, 0.01);
  close(element.volume, 0.1);
  assert.equal(gain.gain.value, 1);
  media.applyMediaVolume(element, 1.25);
  assert.equal(contexts, 1);
  assert.equal(sources, 1);
  assert.equal(resumed, 1);
  assert.equal(media.applyMediaVolume(element, 2), 2);
  assert.equal(gain.gain.value, 10);
  assert.equal(element.volume, 1);
  media.releaseMediaVolume(element);
  assert.equal(closed, 1);
});

test('devices without Web Audio fall back to valid normal volume', () => {
  const media = load('app/lib/media.ts', { window: {} });
  const element = { volume: 0.5 };
  assert.equal(media.applyMediaVolume(element, 1.5), 1);
  assert.equal(element.volume, 1);
});

test('previous quiet and boosted settings migrate once to the supported range', () => {
  for (const position of [0, 0.01, 0.25, 0.625, 0.75, 1, 1.5, 2]) {
    const localStorage = storage();
    localStorage.setItem('tms_volume_curve', '5');
    localStorage.setItem('tms_volume', String(position));
    const media = load('app/lib/media.ts', { window: { localStorage } });
    const migrated = media.readStoredVolumePosition();
    close(media.volumeFromSlider(migrated), cappedAmplitude(position > 1 ? 10 ** (position - 1) : oldQuietAmplitude(position)));
    assert.equal(localStorage.getItem('tms_volume_curve'), '6');
    assert.equal(media.readStoredVolumePosition(), migrated);
  }
});
