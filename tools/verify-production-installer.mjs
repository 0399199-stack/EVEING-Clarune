import assert from 'node:assert/strict';
import { createPublicKey, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const project = resolve(import.meta.dirname, '..');
const workspace = resolve(project, '../..');
const output = resolve(project, '../EVEINGClarune_Installer');
const installer = join(output, 'EVEING-Clarune-1.0.0-rc.1-Full-x64-Setup-fix1.exe');
const evidence = JSON.parse(await readFile(installer.replace(/\.exe$/, '.evidence.json'), 'utf8'));
const expectedFingerprint = '7b5820e3f82944f0358d0143231d61dcad815c48efd9d196184ccb2c46a69c5d';
const testApp = join(workspace, 'work/full-installer-review/run-6qT644/extracted/{app}');
const review = resolve(project, '../EVEINGClarune_Release_Review');
await mkdir(review, { recursive: true });
const extracted = await mkdtemp(join(workspace, 'work/owner-installer-'));
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const checks = [];
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS ' + label); };
check('Normal installer is not a disposable test build', evidence.testOnly === false && evidence.publicKeyFingerprint === expectedFingerprint);
check('Final installer bytes match packaging SHA-256', await sha256(installer) === evidence.installerSha256);
const unpacker = join(workspace, 'work/installer-tools/innounp-latest/innounp.exe');
check('Archive extractor is the verified 2.71.1 binary', await sha256(unpacker) === '94377351f03257b06e221285b16d41108040151ab672b96faf1d3d874a7d0a32');
console.log('Extracting selected release metadata and application code without executing setup');
const extraction = spawnSync(unpacker, ['-x', '-b', '-q', '-a', `-d${extracted}`, installer,
  '{app}\\resources\\license-public-key.pem', '{app}\\clarune-installation.ini',
  '{app}\\resources\\ai\\runtime-manifest.json', '{app}\\resources\\app\\out\\*'],
{ windowsHide: true, shell: false, timeout: 180000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.equal(extraction.status, 0, extraction.error?.message || extraction.stderr || extraction.stdout);
const app = join(extracted, '{app}');
const pem = await readFile(join(app, 'resources/license-public-key.pem'), 'utf8');
check('Actual archived customer key is an SPKI public key without private material', pem.startsWith('-----BEGIN PUBLIC KEY-----') && !pem.includes('PRIVATE KEY'));
const key = createPublicKey(pem);
const fingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
check('Archived Ed25519 public key matches the owner-supplied key', key.asymmetricKeyType === 'ed25519' && fingerprint === expectedFingerprint);
const marker = await readFile(join(app, 'clarune-installation.ini'), 'utf8');
check('Actual archive contains the customer installation identifier, not the test identifier', marker.includes('AppId=com.eveing.clarune.desktop') && !marker.includes('installer-test'));
check('Customer AI manifest matches the fully verified test installer', await sha256(join(app, 'resources/ai/runtime-manifest.json')) === await sha256(join(testApp, 'resources/ai/runtime-manifest.json')));
let codeFiles = 0;
async function compareCode(relative = 'resources/app/out') {
  for (const entry of await readdir(join(app, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) await compareCode(name);
    else { assert.equal(await sha256(join(app, name)), await sha256(join(testApp, name)), name); codeFiles++; }
  }
}
await compareCode();
check('Archived application code is identical to the packaged version that passed real model and activation tests', codeFiles >= 5);
await writeFile(join(review, 'production-installer-verification-fix1.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), installer,
  installerBytes: evidence.bytes, installerSha256: evidence.installerSha256, publicKeyFingerprint: fingerprint,
  extracted, codeFiles, checks, passed: checks.length, setupExecuted: false, publisherCodeSigned: false }, null, 2));
console.log(JSON.stringify({ passed: checks.length, codeFiles, extracted }));
