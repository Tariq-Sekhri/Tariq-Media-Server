const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');
const { reconcileModalInert } = load('app/lib/modal-inert.ts');

function element(inert = false, aria = null) {
  return {
    inert, aria,
    getAttribute() { return this.aria; },
    setAttribute(_key, value) { this.aria = value; },
    removeAttribute() { this.aria = null; },
  };
}

test('switching from account menu to settings restores each original inert state on close', () => {
  const header = element();
  const content = element();
  const hidden = new Map();
  reconcileModalInert(hidden, new Set([content]));
  reconcileModalInert(hidden, new Set([content, header]));
  reconcileModalInert(hidden, new Set([content, header]));
  assert.equal(content.inert, true);
  assert.equal(header.inert, true);
  reconcileModalInert(hidden, new Set());
  assert.equal(content.inert, false);
  assert.equal(header.inert, false);
  assert.equal(header.aria, null);
  assert.equal(hidden.size, 0);
});

test('modal restoration retains an intentionally inert element and existing ARIA state', () => {
  const background = element(true, 'false');
  const hidden = new Map();
  reconcileModalInert(hidden, new Set([background]));
  reconcileModalInert(hidden, new Set());
  assert.equal(background.inert, true);
  assert.equal(background.aria, 'false');
});
