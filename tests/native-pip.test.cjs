const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Android auto-enters PiP on Home whenever the last state the web layer sent
// was "active". Leaving the player must clear it, or Home shrinks the library
// into a PiP window with nothing playing.

test('watch page clears native PiP eligibility when it unmounts', () => {
  const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
  const cleanup = source.match(/useEffect\(\(\) => \(\) => \{([\s\S]*?)\n  \}, \[\]\);/g) ?? [];
  assert.ok(
    cleanup.some((body) => /syncNativePipState\(\{\s*active:\s*false\b/.test(body)),
    'an unmount-only effect must send syncNativePipState({ active: false, ... })',
  );
});

test('watch page only reports PiP as active while a video is playing', () => {
  const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
  assert.match(source, /active:\s*Boolean\(details\?\.kind === "video" && playing && !audioOnly\)/);
});

test('a new WebView document clears native PiP eligibility', () => {
  const client = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/TmsWebViewClient.java', 'utf8');
  const onPageStarted = client.match(/void onPageStarted\([^)]*\) \{([\s\S]*?)\r?\n    \}/)?.[1] ?? '';
  assert.match(onPageStarted, /MainActivity\.clearPipForNavigation\(\)/);
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  assert.match(activity, /static void clearPipForNavigation\(\) \{[\s\S]*?setPipState\(false,/);
});

test('PiP control taps are delivered as foreground broadcasts', () => {
  // Background broadcasts can sit in Android's queue for seconds, making
  // every PiP button (audio, play/pause, next, close) feel unresponsive.
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  const pipAction = activity.match(/private RemoteAction pipAction\([\s\S]*?\r?\n    \}/)?.[0] ?? '';
  assert.match(pipAction, /addFlags\(Intent\.FLAG_RECEIVER_FOREGROUND\)/);
});

test('switching to audio starts the HLS stream at the current position', () => {
  const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
  const start = source.slice(source.indexOf('  const startBackgroundAudio ='), source.indexOf('  const startBackgroundAudioLatest ='));
  assert.match(start, /new Hls\(\{[^}]*startPosition: video\.currentTime/);
});

test('PiP "Switch to audio" dismisses the window immediately, not after audio loads', () => {
  // Waiting for the audio element to load before dismissing left the PiP
  // window on screen for ~5 seconds after the tap.
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  const audioOnly = activity.match(/if \("audio-only"\.equals\(action\)\) \{([\s\S]*?)\}/)?.[1] ?? '';
  assert.match(audioOnly, /exitTmsPip\(\);/);
  const source = fs.readFileSync('app/watch/page.tsx', 'utf8');
  const start = source.slice(source.indexOf('  const startBackgroundAudio ='), source.indexOf('  const startBackgroundAudioLatest ='));
  assert.doesNotMatch(start, /exitNativePip/);
});
