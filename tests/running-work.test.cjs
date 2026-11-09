const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const work = load('app/lib/running-work.ts');

test('finished-work toggle hides completed work while keeping scans and failures visible', () => {
  assert.equal(work.isActiveWork('scanning library'), true);
  assert.equal(work.isFinishedWork('scanning library'), false);
  assert.equal(work.showWork('complete', false), false);
  assert.equal(work.showWork('completed', false), false);
  assert.equal(work.showWork('complete', true), true);
  assert.equal(work.showWork('scanning library', false), true);
  assert.equal(work.showWork('finished with errors', false), true);
});

test('paused and unavailable work count as inactive; failed finishes still need attention', () => {
  for (const status of ['paused', 'status unavailable', 'waiting for computer idle', 'waiting for worker']) {
    assert.equal(work.isActiveWork(status), false);
    assert.equal(work.isFinishedWork(status), false);
  }
  assert.equal(work.isFinishedWork('finished with errors'), true);
  assert.equal(work.needsWorkAttention('finished with errors'), true);
  assert.equal(work.needsWorkAttention('status unavailable'), true);
  assert.equal(work.needsWorkAttention('complete'), false);
});

test('transcode titles keep the episode filename instead of truncating the library path', () => {
  assert.equal(work.workTitle('Library/Long Series/Season 1/Episode 100.mkv', 'FFmpeg transcode'), 'Episode 100.mkv');
  assert.equal(work.workTitle('Library\\Season 1\\Episode 8.mp4', 'active playback'), 'Episode 8.mp4');
  assert.equal(work.workTitle('Library/Season 1/Episode 8.mp4', 'Browser audio remux'), 'Episode 8.mp4');
  assert.equal(work.workTitle('Playlist/title', 'yt-dlp playlist'), 'Playlist/title');
});
