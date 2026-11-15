const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const generatorUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'regression', 'generate-media.mjs')).href;
const ffmpeg = process.env.TMS_FFMPEG || path.join(process.env.ProgramFiles || '', 'Jellyfin', 'Server', 'ffmpeg.exe');
const skip = fs.existsSync(ffmpeg) ? false : 'ffmpeg not available';

const exact = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact'];
const recipesIn = dir => [
  {output: path.join(dir, 'tone.mp3'), inputs: [], args: ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', ...exact, '-c:a', 'libmp3lame', '-t', '1', '-f', 'mp3']},
  {output: path.join(dir, 'tone.webm'), inputs: [], args: ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', ...exact, '-c:a', 'libopus', '-t', '1', '-f', 'webm']},
];

async function setup() {
  const {generateMedia} = await import(generatorUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-media-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const run = (recipes = recipesIn(dir)) => generateMedia({ffmpeg, recipes, manifestPath, log() {}});
  return {dir, manifestPath, run, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

test('regenerated fixtures are bit-identical and unchanged recipes are reused', {skip}, async () => {
  const {dir, run, cleanup} = await setup();
  try {
    const first = await run();
    assert.deepEqual(first.results.map(r => r.status), ['generated', 'generated']);
    fs.rmSync(path.join(dir, 'tone.webm'));
    fs.rmSync(path.join(dir, 'manifest.json'));
    const second = await run();
    assert.deepEqual(second.results.map(r => r.sha256), first.results.map(r => r.sha256));
    assert.equal(second.identity, first.identity);
    const third = await run();
    assert.deepEqual(third.results.map(r => r.status), ['cached', 'cached']);
    assert.equal(third.identity, first.identity);
  } finally { cleanup(); }
});

test('tampered outputs are never trusted and recipe changes regenerate', {skip}, async () => {
  const {dir, run, cleanup} = await setup();
  try {
    const first = await run();
    fs.appendFileSync(path.join(dir, 'tone.mp3'), 'x');
    const repaired = await run();
    assert.deepEqual(repaired.results.map(r => r.status), ['repaired', 'cached']);
    assert.equal(repaired.identity, first.identity);
    const changed = recipesIn(dir);
    changed[0].args = changed[0].args.map(a => (a === '1' ? '2' : a));
    const regenerated = await run(changed);
    assert.equal(regenerated.results[0].status, 'regenerated');
    assert.notEqual(regenerated.identity, first.identity);
  } finally { cleanup(); }
});

test('a failed generation removes partial output and leaves no valid cache entry', {skip}, async () => {
  const {dir, manifestPath, run, cleanup} = await setup();
  try {
    await run();
    const broken = recipesIn(dir);
    broken[0].args = broken[0].args.map(a => (a === 'libmp3lame' ? 'no-such-codec' : a));
    await assert.rejects(run(broken), /Failed to generate/);
    assert.equal(fs.existsSync(`${broken[0].output}.partial`), false);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.outputs[broken[0].output], undefined);
    const restored = await run();
    assert.equal(restored.results[0].status, 'regenerated');
  } finally { cleanup(); }
});
