// Start TMS and open an audio-only library/offline view before running.
// Example: node scripts/check-android-audio.mjs --serial emulator-5554 --action tap --match Recording
// Actions: tap, all, shuffle, next. Does not log media names, URLs or credentials.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const serial = args.get('--serial');
const action = args.get('--action') ?? 'tap';
const match = args.get('--match');
assert.ok(serial, '--serial is required; never select a device implicitly');
assert.ok(['tap', 'all', 'shuffle', 'next'].includes(action), 'unsupported action');
if (action === 'tap') assert.ok(match, '--match is required for tap');
const adb = (...command) => execFileSync('adb', ['-s', serial, ...command], { encoding: 'utf8' }).trim();
const pid = adb('shell', 'pidof', '-s', 'ca.sekhrit.tms');
assert.match(pid, /^\d+$/, 'TMS must already be running');
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
let socket;
try {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // Returning from the bundled offline shell can retain a detached WebView.
  const attached = targets.filter(target => {
    try { return JSON.parse(target.description).attached === true; } catch { return false; }
  });
  const active = attached.length ? attached : targets;
  assert.equal(active.length, 1, 'expected one attached TMS WebView');
  socket = new WebSocket(active[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const qualities = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && new URL(message.params.request.url).pathname === '/api/qualities') qualities.push(true);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('WebView command timed out')); }, 10_000);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, 'app interaction failed');
    return result.result.value;
  };
  await call('Network.enable');
  const before = await evaluate('location.pathname + location.search');
  assert.ok(!before.startsWith('/watch'), 'begin in the browse view');
  const previousSource = await evaluate("document.querySelector('audio')?.currentSrc ?? ''");
  const clicked = await evaluate(`(() => {
    const action = ${JSON.stringify(action)}, match = ${JSON.stringify(match)};
    const element = action === 'tap'
      ? [...document.querySelectorAll('a.card-label-link,button.media-list-main')].find(e => e.textContent.includes(match))
      : [...document.querySelectorAll('button')].find(e => action === 'next'
        ? /^next(?::|\s|$)/i.test(e.getAttribute('aria-label') ?? '')
        : e.textContent.trim() === (action === 'all' ? 'Play all' : 'Shuffle'));
    if (!element || element.disabled) return false;
    element.click(); return true;
  })()`);
  assert.equal(clicked, true, 'requested control was not available');
  const state = () => evaluate(`(() => {
    const audio = document.querySelector('.miniplayer audio') ?? document.querySelector('audio');
    return { route: location.pathname + location.search, audio: audio ? { time: audio.currentTime, paused: audio.paused,
      ready: audio.readyState, failed: Boolean(audio.error), source: audio.currentSrc } : null,
      online: navigator.onLine };
  })()`);
  const deadline = Date.now() + 15_000;
  let last, advancing = false;
  while (Date.now() < deadline) {
    const first = await state();
    assert.equal(first.route, before, 'audio changed the browse route');
    const ready = first.audio && !first.audio.paused && first.audio.ready >= 3 && !first.audio.failed;
    const selected = ready && (action !== 'tap' || decodeURIComponent(first.audio.source).includes(match))
      && (action !== 'next' || first.audio.source !== previousSource);
    if (!selected) {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    // Selecting another item can reuse the element while its source/resume
    // position changes. Measure one stable source, never two different tracks.
    await new Promise(resolve => setTimeout(resolve, 1500));
    last = await state();
    assert.equal(last.route, before, 'audio changed the browse route');
    if (last.audio && !last.audio.paused && !last.audio.failed && last.audio.ready >= 3
      && last.audio.source === first.audio.source && last.audio.time > first.audio.time + 0.5) {
      advancing = true;
      break;
    }
  }
  assert.ok(advancing, 'selected audio did not start and advance');
  assert.equal(qualities.length, 0, 'audio requested video inspection');
  console.log(JSON.stringify({ result: 'PASS', action, online: last.online, audioAdvancing: true, browsePreserved: true, videoInspectionRequests: 0 }));
} finally {
  socket?.close();
  adb('forward', '--remove', `tcp:${port}`);
}
