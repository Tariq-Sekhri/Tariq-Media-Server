const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { load, storage, libraryPlayback } = require('./load-ts.cjs');
const localStorage = storage();
const progress = load(path.join(__dirname, '../app/lib/watch-progress.ts'), { window: { localStorage } }, { './library-playback': libraryPlayback({ sleep: { startFresh: true } }) });
const episodes = Array.from({ length: 148 }, (_, index) => ({ path: `episode-${index + 1}` }));
const state = (position, updated, completed = false, duration = 1427) => ({ position, duration, updated, completed });

test('continue after the latest episode credits instead of an older unfinished episode', () => {
  assert.equal(progress.selectSeriesEpisode(episodes, {
    'episode-82': state(712, 100),
    'episode-83': state(0, 101),
    'episode-87': state(1414, 105),
  }).path, 'episode-88');
});

test('resume the most recently watched partial episode even when older gaps exist', () => {
  assert.equal(progress.selectSeriesEpisode(episodes, { 'episode-1': state(58, 1), 'episode-80': state(1059, 10) }).path, 'episode-80');
  assert.equal(progress.selectSeriesEpisode(episodes, { 'episode-80': state(1059, 10), 'episode-81': state(3, 11) }).path, 'episode-81');
});

test('explicit completion advances and finished series stays at finale', () => {
  assert.equal(progress.selectSeriesEpisode(episodes, { 'episode-87': state(1427, 10, true) }).path, 'episode-88');
  assert.equal(progress.selectSeriesEpisode(episodes, { 'episode-148': state(1427, 10, true) }).path, 'episode-148');
});

test('credits completion is bounded and does not treat mid-episode as finished', () => {
  assert.equal(progress.episodeFinished(state(1320, 1)), true);
  assert.equal(progress.episodeFinished(state(1059, 1)), false);
  assert.equal(progress.episodeFinished(state(6500, 1, false, 7200)), false);
});

test('durable position survives a new read and is isolated by account', () => {
  progress.writeLocalWatchProgress(2, 'episode-88', state(712, 20));
  assert.equal(progress.readLocalWatchProgress(2)['episode-88'].position, 712);
  assert.equal(progress.readLocalWatchProgress(1)['episode-88'], undefined);
  assert.equal(progress.readLocalWatchProgress(undefined)['episode-88'], undefined);
});

test('fresh local progress wins over stale server state; newer device progress wins', () => {
  const local = { 'episode-88': state(712, 20) };
  assert.equal(progress.mergeWatchProgress({ 'episode-88': state(0, 19) }, local)['episode-88'].position, 712);
  assert.equal(progress.mergeWatchProgress({ 'episode-88': state(800, 21) }, local)['episode-88'].position, 800);
});

test('a fresh-start library never saves or restores progress, including old local and remote positions', () => {
  const path = 'Sleep/artist/rain.mp3';
  localStorage.setItem('tms:watch-progress:9', JSON.stringify({ [path]: state(120, 1), 'Other/audio.mp3': state(60, 1) }));
  assert.equal(progress.readLocalWatchProgress(9)[path], undefined);
  progress.writeLocalWatchProgress(9, path, state(180, 2));
  assert.equal(progress.readLocalWatchProgress(9)[path], undefined);
  assert.equal(JSON.parse(localStorage.getItem('tms:watch-progress:9'))[path].position, 120);
  const merged = progress.mergeWatchProgress({ [path]: state(240, 3) }, progress.readLocalWatchProgress(9));
  assert.equal(merged[path], undefined);
  assert.equal(merged['Other/audio.mp3'].position, 60);
  for (const path of ['Sleep/a.mp4', 'sleep/artist/a.mp3', 'SLEEP\\a.mp3']) assert.equal(progress.savesWatchProgress(path), false);
  for (const path of ['Sleepers/a.mp3', 'Other/Sleep/a.mp3']) assert.equal(progress.savesWatchProgress(path), true);
});

test('libraries save progress unless their start-fresh toggle is on', () => {
  const saved = storage();
  const off = load(path.join(__dirname, '../app/lib/watch-progress.ts'), { window: { localStorage: saved } }, { './library-playback': libraryPlayback({}) });
  off.writeLocalWatchProgress(7, 'Sleep/a.mp3', state(90, 1));
  assert.equal(off.readLocalWatchProgress(7)['Sleep/a.mp3'].position, 90);
  const on = load(path.join(__dirname, '../app/lib/watch-progress.ts'), { window: { localStorage: saved } }, { './library-playback': libraryPlayback({ sleep: { startFresh: true } }) });
  assert.equal(on.readLocalWatchProgress(7)['Sleep/a.mp3'], undefined);
});

test('offline progress uploads while newer progress from another device wins', async () => {
  const remote = { 'Library/newer.mp4': { position: 80, duration: 100, updated: 20 } };
  const local = {
    'Library/newer.mp4': { position: 30, duration: 100, updated: 10 },
    'Library/local.mp4': { position: 60, duration: 100, updated: 30 },
  };
  const sent = [];
  const merged = await progress.syncLocalWatchProgress(remote, local, async (path, value) => sent.push([path, value]));
  assert.deepEqual(sent.map(([path]) => path), ['Library/local.mp4']);
  assert.equal(merged['Library/newer.mp4'].position, 80);
  assert.equal(merged['Library/local.mp4'].position, 60);
});

test('failed progress uploads preserve local progress for retry', async () => {
  const local = { 'Library/local.mp4': { position: 60, duration: 100, updated: 30 } };
  await assert.rejects(progress.syncLocalWatchProgress({}, local, async () => { throw new Error('Disconnected'); }), /Disconnected/);
  assert.equal(local['Library/local.mp4'].position, 60);
  const sent = [];
  await progress.syncLocalWatchProgress({}, local, async path => sent.push(path));
  assert.deepEqual(sent, ['Library/local.mp4']);
});

test('a same-second offline edit is uploaded once instead of remaining local forever', async () => {
  const remote = { 'Library/video.mp4': { position: 40, duration: 100, updated: 20 } };
  const local = { 'Library/video.mp4': { position: 60, duration: 100, updated: 20 } };
  let sends = 0;
  const save = async (path, state) => { sends++; remote[path] = { ...state }; };
  await progress.syncLocalWatchProgress(remote, local, save);
  await progress.syncLocalWatchProgress(remote, local, save);
  assert.equal(sends, 1);
  assert.equal(remote['Library/video.mp4'].position, 60);
});
