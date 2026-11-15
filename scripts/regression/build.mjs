import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {sourceIdentity,buildIdentity} from './identity.mjs';
import assert from 'node:assert/strict';
const source=await sourceIdentity();
execFileSync('cmd.exe',['/d','/c','npm.cmd','run','build'],{stdio:'inherit',windowsHide:true});
assert.equal(await sourceIdentity(),source,'Source changed while building');
await writeFile('dist/client/regression-build.json',JSON.stringify({source,build:await buildIdentity()}));
