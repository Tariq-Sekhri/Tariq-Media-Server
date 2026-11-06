const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

exports.load = (file, globals = {}, imports = {}) => {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, URLSearchParams, Headers, Response,
    AbortSignal, DOMException, console, setTimeout, clearTimeout,
    require: (name) => {
      if (!(name in imports)) throw new Error(`Unmocked import: ${name}`);
      return imports[name];
    },
    ...globals,
  }, { filename: file });
  return module.exports;
};

exports.storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

// Per-library playback toggles as saved on a device, e.g. { sleep: { startFresh: true } }.
exports.libraryPlayback = (settings = {}, { native = false, localStorage = exports.storage() } = {}) => {
  localStorage.setItem('tms:library-playback', JSON.stringify(settings));
  const window = { localStorage, ...(native ? { Capacitor: { isNativePlatform: () => true } } : {}) };
  return exports.load('app/lib/library-playback.ts', { window });
};
