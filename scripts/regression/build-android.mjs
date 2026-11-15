// Gradle overlays QA configuration in its normal generated build directory.
// No shared source asset is rewritten, even temporarily.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const file='android/app/src/main/assets/capacitor.config.json';
const original=await readFile(file);
execFileSync('cmd.exe',['/d','/c','.\\gradlew.bat',':app:assembleDebug',':app:assembleDebugAndroidTest','-PregressionApp=true','--console=plain'],{cwd:'android',stdio:'inherit',windowsHide:true});
assert.ok(original.equals(await readFile(file)),'Build changed shared Capacitor configuration');
const qa=JSON.parse(await readFile('android/app/build/generated/regressionAssets/capacitor.config.json','utf8'));
assert.equal(qa.server.url,'http://127.0.0.1:3100');
assert.equal(qa.plugins.TmsConnection.tailscaleUrl,'');
