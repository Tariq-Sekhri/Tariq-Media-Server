const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { execFileSync } = require('node:child_process');
const { load } = require('./load-ts.cjs');
const media = load('app/lib/media.ts');
const { browseTagFilters } = load('app/lib/browse-tag-filters.ts');

// Exercise the actual page scope selection AND its actual button JSX.
// A revision can be supplied to prove that these fail on the broken page.
const source = process.env.TMS_FILTER_PAGE_REVISION
  ? execFileSync('git', ['show', `${process.env.TMS_FILTER_PAGE_REVISION}:app/page.tsx`], { encoding: 'utf8' })
  : fs.readFileSync('app/page.tsx', 'utf8');
const page = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let filterMemo;
let filterStrip;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
    && node.name.elements.some((element) => element.name.getText(page) === 'filterTags')) {
    filterMemo = node.initializer.arguments[0].getText(page);
  }
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(page) === 'className'
      && attribute.initializer?.text === 'tag-strip')) filterStrip = node.getText(page);
  ts.forEachChild(node, visit);
}
visit(page);
assert.ok(filterMemo && filterStrip, 'Must find the real page filter logic and button markup');
const compiled = ts.transpileModule(`
  module.exports = function({ items, filterCatalog = items, currentFolder, activeTags = [] }) {
    const section = 'library', customTags = {}, FAVORITES_FILTER = 'Favorites';
    const { filters: filterTags } = (${filterMemo})();
    const setActiveTags = () => {};
    return (${filterStrip});
  };
`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUnderTest = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleUnderTest, React, browseTagFilters, inheritedTags: media.inheritedTags,
});

const folder = 'Music/Sample Album';
// An audio-only folder: 55 MP3 + 25 M4A.
const names = [...Array.from({ length: 55 }, (_, i) => `track-${i}.mp3`), ...Array.from({ length: 25 }, (_, i) => `track-${i}.m4a`)];
const items = names.map((name) => media.apiEntryToMediaItem({
  path: `${folder}/${name}`, name, kind: 'file', size: 0, created_at: 0,
}));
assert.ok(items.every((item) => item?.kind === 'audio'), 'The sample folder must contain only audio');
const unrelatedImage = media.apiEntryToMediaItem({
  path: 'Music/Other/cover.jpg', name: 'cover.jpg', kind: 'file', size: 0, created_at: 0,
});
function buttons(activeTags = []) {
  const html = renderToStaticMarkup(moduleUnderTest.exports({
    items, currentFolder: folder, filterCatalog: [...items, unrelatedImage], activeTags,
  }));
  const labels = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<\/button>/g)].map((match) => match[1]);
  assert.ok(labels.includes('All') && labels.includes('Favorites'), 'Must inspect rendered filter buttons');
  return labels;
}

test('Audio-only folder page renders no Videos filter button (0 videos)', () => {
  assert.equal(buttons().includes('Videos'), false);
});

test('Audio-only folder page renders no Images filter button (0 images)', () => {
  assert.equal(buttons().includes('Images'), false);
});

test('Audio-only folder page renders no Audio filter button (all audio), even when Audio was selected', () => {
  assert.equal(buttons(['Audio']).includes('Audio'), false);
});
