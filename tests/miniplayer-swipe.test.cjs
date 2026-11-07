const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function sourceAst(path) {
  return ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const player = sourceAst('app/MiniAudioPlayer.tsx');
function find(ast, predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; else ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(found);
  return found;
}
function evaluate(node, ast, context) {
  return vm.runInContext(ts.transpile(`(${node.getText(ast)})`, { target: ts.ScriptTarget.ES2022 }), context);
}
function harness() {
  const calls = [];
  const context = vm.createContext({
    expanded: false, playing: true, item: { id: 2 },
    previousItem: { id: 1 }, nextItem: { id: 3 },
    trackSwipeStart: { current: null }, changeItem: (...args) => calls.push(args),
  });
  const load = name => evaluate(find(player, node => ts.isVariableDeclaration(node) && node.name.getText(player) === name).initializer, player, context);
  const start = load('startTrackSwipe');
  const end = load('finishTrackSwipe');
  const swipe = (x, y = 0) => {
    start({ touches: [{ clientX: 150, clientY: 50 }] });
    end({ touches: [], changedTouches: [{ clientX: 150 + x, clientY: 50 + y }] });
  };
  return { context, calls, start, end, swipe };
}

test('collapsed title swipes select the adjacent item and preserve pause state', () => {
  const h = harness();
  h.swipe(-80);
  assert.equal(h.calls[0][0].id, 3);
  assert.equal(h.calls[0][1], true);
  h.context.playing = false;
  h.swipe(80);
  assert.equal(h.calls[1][0].id, 1);
  assert.equal(h.calls[1][1], false);
});

test('vertical movement, small drags, expanded mode, and queue boundaries do not skip', () => {
  const h = harness();
  h.swipe(20);
  h.swipe(55, 80);
  h.context.expanded = true;
  h.swipe(-80);
  h.context.expanded = false;
  h.context.nextItem = null;
  h.swipe(-80);
  h.context.previousItem = null;
  h.swipe(80);
  assert.equal(h.calls.length, 0);
});

test('multi-touch, cancelled gestures, and outgoing-track gestures do not skip', () => {
  const h = harness();
  const touch = { clientX: 150, clientY: 50 };
  h.start({ touches: [touch, touch] });
  h.end({ touches: [], changedTouches: [{ clientX: 50, clientY: 50 }] });
  h.start({ touches: [touch] });
  h.context.item = { id: 4 };
  h.end({ touches: [], changedTouches: [{ clientX: 50, clientY: 50 }] });
  h.context.trackSwipeStart.current = null;
  h.end({ touches: [], changedTouches: [{ clientX: 50, clientY: 50 }] });
  assert.equal(h.calls.length, 0);
});

test('sidebar swipe ignores player and tag scrolling but retains ordinary navigation swipes', () => {
  const ast = sourceAst('app/page.tsx');
  const shell = find(ast, node => ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'main');
  const attribute = name => shell.attributes.properties.find(node => node.name?.text === name).initializer.expression;
  class Element {
    constructor(ancestorClass) { this.ancestorClass = ancestorClass; }
    closest(selector) { return selector.split(',').some(part => part.trim() === this.ancestorClass); }
  }
  const opened = [];
  const context = vm.createContext({ Element, sidebarSwipeStart: { current: null }, performance: { now: () => 1 }, setRailDrawerOpen: value => opened.push(value), railDrawerOpen: false });
  const start = evaluate(attribute('onTouchStart'), ast, context);
  const end = evaluate(attribute('onTouchEnd'), ast, context);
  for (const ancestor of ['.miniplayer', '.tag-strip']) {
    for (const delta of [-100, 100]) {
      context.railDrawerOpen = true;
      context.sidebarSwipeStart.current = { x: 20, y: 20, time: 1 };
      start({ target: new Element(ancestor), touches: [{ clientX: 120, clientY: 20 }] });
      end({ changedTouches: [{ clientX: 120 + delta, clientY: 20 }] });
      assert.deepEqual(opened, [], `${ancestor} owns swipes in both directions`);
    }
  }
  context.railDrawerOpen = false;
  start({ target: new Element('.content'), touches: [{ clientX: 20, clientY: 20 }] });
  end({ changedTouches: [{ clientX: 120, clientY: 20 }] });
  assert.deepEqual(opened, [true]);
  context.railDrawerOpen = true;
  start({ target: new Element('.content'), touches: [{ clientX: 120, clientY: 20 }] });
  end({ changedTouches: [{ clientX: 20, clientY: 20 }] });
  assert.deepEqual(opened, [true, false]);
});
