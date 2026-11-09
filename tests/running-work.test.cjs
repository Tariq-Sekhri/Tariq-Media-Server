const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const work = load('app/lib/running-work.ts');

test('library scans are active with unknown progress until remuxing starts', () => {
  assert.equal(work.isActiveWork('scanning library'), true);
  assert.equal(work.isFinishedWork('scanning library'), false);
  assert.equal(work.workProgress('scanning library', 0), null);
  assert.equal(work.workProgress('running', 0), 0);
  assert.equal(work.workProgress('running', 0.5), 0.5);
  assert.equal(work.workProgress('complete', 1), 1);
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
