/* eslint-disable @typescript-eslint/no-require-imports -- Node's test harness uses CommonJS. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load-ts.cjs');

test('copy writes PNG pixels immediately while image encoding is still pending', async () => {
  const image = { complete: true, naturalWidth: 640, naturalHeight: 480, src: 'data:image/jpeg;base64,example' };
  const png = new Blob(['pixels'], { type: 'image/png' });
  let encode, written, drawn;
  const canvas = { getContext: () => ({ drawImage: (...args) => { drawn = args; } }), toBlob: (callback, type) => { assert.equal(type, 'image/png'); encode = callback; } };
  const { copyNoteImage } = load('app/lib/copy-note-image.ts', {
    document: { createElement: tag => { assert.equal(tag, 'canvas'); return canvas; } },
    navigator: { clipboard: { write: items => { written = items; return items[0].data['image/png'].then(blob => assert.equal(blob, png)); } } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
  });
  const pending = copyNoteImage(image);
  assert.equal(written.length, 1);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 480);
  assert.deepEqual(drawn, [image, 0, 0]);
  encode(png);
  await pending;
});

test('insecure or unsupported browsers receive a useful error', async () => {
  const { copyNoteImage } = load('app/lib/copy-note-image.ts', { navigator: {} });
  await assert.rejects(copyNoteImage({}), /HTTPS or localhost/);
});

test('unloaded images are not reported as copied', async () => {
  const { copyNoteImage } = load('app/lib/copy-note-image.ts', {
    navigator: { clipboard: { write: items => items[0].data['image/png'] } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
  });
  await assert.rejects(copyNoteImage({ complete: false }), /finish loading/);
});

test('clipboard permission failures propagate to the editor', async () => {
  const { copyNoteImage } = load('app/lib/copy-note-image.ts', {
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: callback => callback(new Blob()) }) },
    navigator: { clipboard: { write: () => Promise.reject(new Error('Clipboard access denied')) } },
    ClipboardItem: class {},
  });
  await assert.rejects(copyNoteImage({ complete: true, naturalWidth: 1, naturalHeight: 1 }), /denied/);
});

test('Ctrl+C targets the clicked image even with a collapsed caret', () => {
  const { noteImageForCopy } = load('app/lib/copy-note-image.ts');
  const image = {};
  const editor = { contains: value => value === image };
  const selection = { isCollapsed: true, toString: () => '' };
  assert.equal(noteImageForCopy(editor, image, selection), image);
});

test('selecting text after an image keeps normal text copying', () => {
  const { noteImageForCopy } = load('app/lib/copy-note-image.ts');
  assert.equal(noteImageForCopy({ querySelectorAll: () => [], contains: () => true }, {}, { isCollapsed: false, containsNode: () => false, toString: () => 'note text' }), null);
});

test('range-selected images copy without depending on the last clicked image', () => {
  const { noteImageForCopy } = load('app/lib/copy-note-image.ts');
  const image = {};
  assert.equal(noteImageForCopy({ querySelectorAll: () => [image] }, null, { isCollapsed: false, containsNode: value => value === image }), image);
});

test('clicking an image focuses the editor and creates a native image selection', () => {
  const calls = [];
  const image = { classList: { add: name => calls.push(['selected', name]) } };
  const range = { selectNode: value => calls.push(['range', value]) };
  const selection = { removeAllRanges: () => calls.push(['clear']), addRange: value => calls.push(['add', value]) };
  const { selectNoteImage } = load('app/lib/copy-note-image.ts', {
    document: { createRange: () => range }, window: { getSelection: () => selection },
  });
  selectNoteImage({ querySelectorAll: () => [], focus: () => calls.push(['focus']) }, image);
  assert.equal(calls.findIndex(x => x[0] === 'focus') < calls.findIndex(x => x[0] === 'range'), true);
  assert.equal(calls.find(x => x[0] === 'range')[1], image);
  assert.equal(calls.find(x => x[0] === 'add')[1], range);
});

test('the production Ctrl+C handler copies the selected image instead of text', () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const source = fs.readFileSync('app/RichTextEditor.tsx', 'utf8');
  const code = source.slice(source.indexOf('  const handleKeyDown ='), source.indexOf('  // Color palettes'));
  const image = {};
  let copied, prevented = false;
  const context = {
    useCallback: fn => fn, editorRef: { current: { contains: item => item === image } }, selectedImage: image,
    ...load('app/lib/copy-note-image.ts'),
    window: { getSelection: () => ({ isCollapsed: true, toString: () => '' }) },
    handleCopyImage: item => { copied = item; }, execCmd() {}, handleOpenLinkModal() {},
  };
  vm.runInNewContext(ts.transpileModule(code + '\nglobalThis.press = handleKeyDown;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.press({ ctrlKey: true, key: 'c', preventDefault: () => { prevented = true; } });
  assert.equal(copied, image);
  assert.equal(prevented, true);
  copied = undefined;
  context.window.getSelection = () => ({ isCollapsed: true, toString: () => 'text to copy' });
  context.press({ ctrlKey: true, key: 'c', preventDefault: () => assert.fail('normal text copy must remain native') });
  assert.equal(copied, undefined);
});

test('saving notes removes the temporary selection marker from a clone only', () => {
  const { noteHtmlWithoutImageSelection } = load('app/lib/copy-note-image.ts');
  let removedClass = false, removedAttribute = false;
  const cloneImage = { className: '', classList: { remove: () => { removedClass = true; } }, removeAttribute: () => { removedAttribute = true; } };
  const clone = { querySelectorAll: () => [cloneImage], get innerHTML() { return removedClass ? '<img src="image.png">' : 'selected'; } };
  const editor = { innerHTML: '<img class="notes-image-selected" src="image.png">', cloneNode: deep => { assert.equal(deep, true); return clone; } };
  assert.equal(noteHtmlWithoutImageSelection(editor), '<img src="image.png">');
  assert.equal(removedAttribute, true);
  assert.match(editor.innerHTML, /notes-image-selected/);
});
