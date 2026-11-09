const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./load-ts.cjs');
const { preferredAudioTrack, preloadSegments, cachedFragmentLoader, canDirectPlayVideo } = load('app/lib/episode-preload.ts', { performance });

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
