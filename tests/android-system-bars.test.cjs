const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// TMS runs immersive on Android: the status and navigation bars must stay
// hidden, otherwise they draw over the page header. This has regressed more
// than once via StatusBar/NavigationBar.show() calls in the web layer.

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

test('web code never re-shows the Android system bars', () => {
  const offenders = sourceFiles('app').flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /\b(StatusBar|NavigationBar)\s*\.\s*show\s*\(/.test(source) ? [file] : [];
  });
  assert.deepEqual(offenders, []);
});

test('MainActivity keeps the Android system bars hidden', () => {
  const activity = fs.readFileSync('android/app/src/main/java/ca/sekhrit/tms/MainActivity.java', 'utf8');
  assert.match(activity, /controller\.hide\(WindowInsetsCompat\.Type\.systemBars\(\)\)/);
  assert.doesNotMatch(activity, /\.show\(WindowInsetsCompat\.Type\.(systemBars|statusBars|navigationBars)\(\)\)/);
  for (const hook of ['onCreate', 'onResume', 'onPostResume', 'onWindowFocusChanged']) {
    const body = activity.match(new RegExp(String.raw`void ${hook}\([^)]*\) \{([\s\S]*?)\r?\n    \}`))?.[1] ?? '';
    assert.match(body, /scheduleStickyImmersiveMode\(\)/, `${hook} must re-hide the system bars`);
  }
});
