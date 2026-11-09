const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');

function mount() {
  let update, cleanup;
  const body = { style: { overflow: '', position: '', top: '', width: '' } };
  const original = { ...body.style };
  const document = {
    body, dialogs: [], activeElement: null,
    querySelectorAll() { return this.dialogs; },
    addEventListener() {}, removeEventListener() {},
  };
  const scrolls = [];
  const focused = [];
  const window = { scrollY: 420, scrollTo: (...args) => scrolls.push(args) };
  const { default: ModalIsolation } = load('app/ModalIsolation.tsx', {
    document, window,
    MutationObserver: class {
      constructor(callback) { update = callback; }
      observe() {} disconnect() {}
    },
  }, {
    react: { useEffect: (effect) => { cleanup = effect(); } },
    './lib/modal-inert': { reconcileModalInert() {} },
  });
  ModalIsolation();
  return {
    body, original, scrolls, focused, cleanup: () => cleanup(),
    show(menu) {
      document.dialogs = menu === null ? [] : [{
        getClientRects: () => [1],
        matches: (selector) => selector.split(',').some((part) => part.trim() === `.${menu === true ? 'card-menu' : menu}`),
        focus() { focused.push(menu); }, setAttribute() {}, hasAttribute: () => true,
      }];
      update();
    },
  };
}

test('Add media stays non-modal so its trigger and outside controls remain usable', () => {
  const app = mount();
  app.show('folder-tools-menu');
  assert.deepEqual(app.focused, []);
  assert.deepEqual(app.body.style, app.original);
  app.cleanup();
});

for (const menu of ['card-menu', 'folder-tools-menu', 'account-popover', 'folder-context-menu']) {
test(`opening and closing ${menu} leaves body sizing and scroll untouched`, () => {
  const app = mount();
  app.show(menu);
  assert.deepEqual(app.body.style, app.original);
  app.show(null);
  app.cleanup();
  assert.deepEqual(app.body.style, app.original);
  assert.deepEqual(app.scrolls, []);
});
}

test('menu to dialog and dialog to menu transitions restore the original layout', () => {
  const app = mount();
  app.show(true);
  app.show(false);
  assert.equal(app.body.style.position, 'fixed');
  assert.equal(app.body.style.top, '-420px');
  app.show(true);
  assert.deepEqual(app.body.style, app.original);
  assert.deepEqual(app.scrolls, [[0, 420]]);
  app.show(false);
  app.cleanup();
  assert.deepEqual(app.body.style, app.original);
  assert.deepEqual(app.scrolls, [[0, 420], [0, 420]]);
});
