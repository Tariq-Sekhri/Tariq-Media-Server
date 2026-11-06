const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Android ends the whole app when a WebView renderer dies unhandled, which
// looks like a silent crash because no JavaScript survives to report it.

test('a dead WebView renderer rebuilds the activity instead of killing the app', () => {
  const client = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/TmsWebViewClient.java', 'utf8');
  assert.match(client, /boolean onRenderProcessGone\([\s\S]*?MainActivity\.recoverFromRendererLoss\(/);
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  const recovery = activity.match(/static boolean recoverFromRendererLoss\([\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(recovery, /activity\.recreate\(\)/);
  assert.match(recovery, /if \(!repeated &&/, 'a repeat loss must not reopen the same page');
});

test('the recovered page reports why the renderer died and drops the marker', () => {
  const gate = fs.readFileSync('app/AuthGate.tsx', 'utf8');
  assert.match(gate, /searchParams\.get\("rendererGone"\)/);
  assert.match(gate, /kind: "android-renderer-gone"/);
  assert.match(gate, /searchParams\.delete\("rendererGone"\)/);
});

test('moving within a loaded queue reuses it instead of refetching the library', () => {
  const watch = fs.readFileSync('app/watch/page.tsx', 'utf8');
  assert.match(watch, /setPlaybackSession\(nextSession\);\s*queueNavigationPathRef\.current = item\.path \?\? null;/);
  assert.match(watch, /shared\?\.complete && \(sameSource \|\| sameSession \|\| queueNavigation\)/);
});

test('a standby video slot releases the element captured before unmount', () => {
  const watch = fs.readFileSync('app/watch/page.tsx', 'utf8');
  const slot = watch.match(/function QueueVideoSlot[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(slot, /const video = ref\.current;\s*return \(\) => \{\s*if \(video\)/);
});

test('a stale WebView callback cannot start a second recovery', () => {
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  assert.match(activity, /rendererRecoveryStarted || view != activity.getBridge().getWebView()/);
});
