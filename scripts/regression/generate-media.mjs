// Synthetic media fixtures for the regression/performance suite. Outputs are
// reused unchanged when possible, preserving fixtureIdentity across runs.
// A manifest in private/ caches each output's
// recipe, inputs, tool identity and SHA-256; an output is reused only when all
// of those still match the file on disk.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync, constants, readFileSync} from 'node:fs';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const MANIFEST_VERSION = 1;
export const defaultManifestPath = 'private/regression-media-manifest.json';
export const defaultFfmpeg = () => process.env.TMS_FFMPEG || path.join(process.env.ProgramFiles || '', 'Jellyfin', 'Server', 'ffmpeg.exe');

const tone = 'sine=frequency=440:sample_rate=16000';
// Strip metadata/encoder tags and ask muxers/encoders for reproducible output
// (matroska also writes fixed segment/track UIDs in bitexact mode).
const exact = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'];

export const defaultRecipes = [
  {output: 'private/regression-media.webm', inputs: ['demo/synthetic-motion.webm'],
    args: ['-i', 'demo/synthetic-motion.webm', '-f', 'lavfi', '-i', tone, '-map', '0:v:0', '-map', '1:a:0', ...exact, '-c:v', 'copy', '-c:a', 'libopus', '-t', '15', '-f', 'webm']},
  {output: 'private/regression-tone.mp3', inputs: [],
    args: ['-f', 'lavfi', '-i', tone, ...exact, '-c:a', 'libmp3lame', '-t', '12', '-f', 'mp3']},
  {output: 'private/regression-tone.m4a', inputs: [],
    args: ['-f', 'lavfi', '-i', tone, ...exact, '-c:a', 'aac', '-t', '12', '-f', 'ipod']},
];

const sha256 = data => createHash('sha256').update(data).digest('hex');
const fileHash = async file => { try { return sha256(await readFile(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function toolIdentity(ffmpeg) {
  // Resolve PATH first so the executable we hash is also the one we run.
  const candidates = path.isAbsolute(ffmpeg) || /[\\/]/.test(ffmpeg)
    ? [path.resolve(ffmpeg)]
    : (process.env.PATH || '').split(path.delimiter).flatMap(dir => {
      const extensions = process.platform === 'win32' && !path.extname(ffmpeg)
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
      return extensions.map(ext => path.resolve(dir || '.', ffmpeg + ext));
    });
  const executable = candidates.find(candidate => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
  if (!executable) throw Error(`Cannot find ffmpeg executable: ${ffmpeg}`);
  // Include the binary and the reported build/library configuration.
  const text = execFileSync(executable, ['-version'], {encoding: 'utf8', windowsHide: true});
  return {executable, version: text.split(/\r?\n/)[0].trim(), sha256: sha256(Buffer.concat([readFileSync(executable), Buffer.from(text)]))};
}

async function readManifest(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.version === MANIFEST_VERSION && parsed.outputs && typeof parsed.outputs === 'object') return parsed;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return {version: MANIFEST_VERSION, outputs: {}};
}

async function writeManifest(file, manifest) {
  await mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n');
  await rename(temp, file);
}

// The identity of one output: its exact recipe, its source files' bytes, the
// tool that produced it and the bytes it produced.
const entryKey = (recipe, inputs, tool) => sha256(JSON.stringify({args: recipe.args, inputs, tool: tool.sha256}));

/** Stable digest of the generated fixtures (recipe + tool + output hashes). */
export function mediaIdentity(manifest, recipes = defaultRecipes) {
  return sha256(recipes.map(r => { const e = manifest.outputs[r.output]; if (!e) throw Error(`No cached fixture for ${r.output}`); return `${r.output}:${e.key}:${e.sha256}`; }).join('\n'));
}

export async function generateMedia({ffmpeg = defaultFfmpeg(), recipes = defaultRecipes, manifestPath = defaultManifestPath, log = console.log} = {}) {
  const tool = toolIdentity(ffmpeg);
  const manifest = await readManifest(manifestPath);
  manifest.tool = tool;
  const results = [];
  for (const recipe of recipes) {
    const inputs = {};
    for (const input of recipe.inputs) { const hash = await fileHash(input); if (!hash) throw Error(`Missing fixture input ${input}`); inputs[input] = hash; }
    const key = entryKey(recipe, inputs, tool);
    const cached = manifest.outputs[recipe.output];
    const current = await fileHash(recipe.output);
    if (cached?.key === key && current && current === cached.sha256) {
      results.push({output: recipe.output, sha256: current, status: 'cached'});
      continue;
    }
    // Invalidate before touching the output so a crash can never leave a stale entry marked valid.
    if (cached) { delete manifest.outputs[recipe.output]; await writeManifest(manifestPath, manifest); }
    await mkdir(path.dirname(recipe.output), {recursive: true});
    const partial = `${recipe.output}.partial`;
    try {
      await rm(partial, {force: true});
      execFileSync(tool.executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...recipe.args, partial], {stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true});
      const hash = await fileHash(partial);
      if (!hash) throw Error(`ffmpeg produced no output for ${recipe.output}`);
      await rename(partial, recipe.output);
      manifest.outputs[recipe.output] = {key, args: recipe.args, inputs, tool: tool.version, sha256: hash};
      await writeManifest(manifestPath, manifest);
      results.push({output: recipe.output, sha256: hash, status: current ? (cached?.key === key ? 'repaired' : 'regenerated') : 'generated'});
    } catch (error) {
      await rm(partial, {force: true});
      throw Object.assign(Error(`Failed to generate ${recipe.output}: ${error.message}`), {cause: error});
    }
  }
  for (const r of results) log(`${r.status.padEnd(11)} ${r.sha256} ${r.output}`);
  const identity = mediaIdentity(manifest, recipes);
  log(`media identity ${identity}`);
  return {results, identity, manifest};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateMedia();
