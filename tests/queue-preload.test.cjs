const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { load } = require('./load-ts.cjs');
const { nearbyQueueItems, canBufferQueueVideo, QUEUE_PRELOAD_BYTES } = load('app/lib/queue-preload.ts');

test('large queues only prepare the next three entries and advance the window', () => {
  const queue = Array.from({ length: 8960 }, (_, id) => ({ id }));
  assert.deepEqual(Array.from(nearbyQueueItems(queue, 500), x => x.id), [501, 502, 503]);
  assert.deepEqual(Array.from(nearbyQueueItems(queue, 501), x => x.id), [502, 503, 504]);
  assert.equal(nearbyQueueItems(queue, -1).length, 0);
  assert.equal(nearbyQueueItems(queue, 8959).length, 0);
});

test('direct video buffering has a byte budget and excludes offline or unknown files', () => {
  const clip = { kind: 'video', src: '/media/clip.mp4', sizeBytes: 8 * 1024 * 1024 };
  assert.equal(canBufferQueueVideo(clip), true);
  for (const change of [{ sizeBytes: QUEUE_PRELOAD_BYTES + 1 }, { sizeBytes: undefined }, { offline: {} }, { kind: 'image' }, { src: '' }]) {
    assert.equal(canBufferQueueVideo({ ...clip, ...change }), false);
  }
});

// Exercise the production slot: a silent preload must never trigger playback,
// progress writes, or visible loading state before it is selected.
function videoSlot() {
  const file = 'app/watch/page.tsx';
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'QueueVideoSlot');
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${compiled}\nQueueVideoSlot`, {
    React: { createElement: (tag, props) => ({ tag, props }) },
    useRef: () => ({ current: null }), useEffect: () => {},
  });
}

test('standby is muted and excludes active events; promotion preserves the exact media source', () => {
  const slot = videoSlot();
  const callback = () => { throw Error('standby must not call active callbacks'); };
  const props = { src: '/media/clip.mp4', mediaRef() {}, muted: false, onPlay: callback, onTimeUpdate: callback, onLoadedMetadata: callback, onEnded: callback };
  const standby = slot({ ...props, active: false });
  assert.equal(standby.props.muted, true);
  assert.equal(standby.props.preload, 'auto');
  for (const name of ['onPlay', 'onTimeUpdate', 'onLoadedMetadata', 'onEnded']) assert.equal(standby.props[name], undefined);
  const active = slot({ ...props, active: true });
  assert.equal(active.tag, standby.tag);
  assert.equal(active.props.src, standby.props.src);
  assert.equal(active.props.onPlay, callback);
  assert.equal(active.props.muted, false);
  assert.equal(slot({ ...props, src: undefined, active: false }).props.preload, 'none');
});
