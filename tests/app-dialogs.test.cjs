const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

test('app screens use in-app dialogs instead of browser alert, confirm, or prompt', () => {
  const violations = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node)) {
          const call = node.expression;
          const name = ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call)
            && ['window', 'globalThis', 'self'].includes(call.expression.getText(source)) ? call.name.text : '';
          if (['alert', 'confirm', 'prompt'].includes(name)) violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan('app');
  assert.deepEqual(violations, []);
});

test('online and offline app roots provide the shared confirmation dialog', () => {
  for (const file of ['app/layout.tsx', 'app/client-entry.tsx']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /<AppConfirmProvider>/, file);
    assert.match(source, /<\/AppConfirmProvider>/, file);
  }
});
