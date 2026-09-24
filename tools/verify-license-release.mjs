import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';

const project = resolve(import.meta.dirname, '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-release-license-'));
const appDirectory = join(scratch, 'test-app');
const profile = join(scratch, 'profile');
const review = process.env.CLARUNE_REVIEW_DIR || resolve(project, '../Release_Review/license-e2e');
await mkdir(review, { recursive: true });
await mkdir(join(appDirectory, 'resources'), { recursive: true });
const builtMain = await readFile(join(project, 'out/main/index.js'), 'utf8');
assert.ok(builtMain.includes('activation-state.bin') && builtMain.includes('Application is closing'), 'Build the release source before this test');
await cp(join(project, 'out'), join(appDirectory, 'out'), { recursive: true });
await cp(join(project, 'resources/branding'), join(appDirectory, 'resources/branding'), { recursive: true });
const packageJson = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
await writeFile(join(appDirectory, 'package.json'), JSON.stringify(packageJson, null, 2));
await symlink(join(project, 'node_modules'), join(appDirectory, 'node_modules'), 'junction');

// The sole key written to disk is this disposable TEST public key. Private key stays in this process.
let { privateKey, publicKey } = generateKeyPairSync('ed25519');
await writeFile(join(appDirectory, 'resources/license-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
const fixture = join(scratch, 'license-test-image.png');
await sharp({ create: { width: 96, height: 64, channels: 4, background: { r: 60, g: 170, b: 215, alpha: 0.7 } } }).png().toFile(fixture);
const fixtureBytes = Array.from(await readFile(fixture));
const checks = [], layouts = [], errors = [];
const sanitize = text => String(text).replace(/CLARUNE-(?:DEVICE|LICENSE)-1\.[A-Za-z0-9_-]+/g, '[redacted test token]');
const check = (name, pass = true) => { assert.ok(pass, name); checks.push(name); console.log('PASS ' + name); };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
let app, page;
let deviceReadAvailable = false;
const issue = claims => {
  const payload = Buffer.from(JSON.stringify(claims));
  const envelope = { version: 1, alg: 'Ed25519', payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') };
  return 'CLARUNE-LICENSE-1.' + Buffer.from(JSON.stringify(envelope)).toString('base64url');
};

async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [appDirectory, `--user-data-dir=${profile}`], env });
  page = await app.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(sanitize(error.message)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(resolve(actualProfile).toLowerCase(), resolve(profile).toLowerCase(), 'Must use the isolated test profile');
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1280, 820); window.webContents.setBackgroundThrottling(false);
    globalThis.__licenseQa = { saveDialogs: 0, openDialogs: 0, savePath: null };
    dialog.showSaveDialog = async () => {
      globalThis.__licenseQa.saveDialogs++;
      return globalThis.__licenseQa.savePath ? { canceled: false, filePath: globalThis.__licenseQa.savePath } : { canceled: true };
    };
    dialog.showOpenDialog = async () => { globalThis.__licenseQa.openDialogs++; return { canceled: true, filePaths: [] }; };
    // Only capability readout is stubbed to enable the start button. Real AI/export/activation handlers are untouched.
    ipcMain.removeHandler('image:upscale-status');
    ipcMain.handle('image:upscale-status', () => ({ ok: true, value: { ready: true, localOnly: true } }));
  });
  await page.getByTestId('enhance-model').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('clarune:upscale-runtime-change')));
}

async function close() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
  await closed; app = null; page = null;
}

async function dismissLicense() {
  if (await page.locator('.license-dialog').count()) await page.locator('.license-dialog .dialog-close').click();
}

async function screenshot(name) {
  await page.screenshot({ path: join(review, name), mask: [page.getByTestId('license-machine'), page.getByTestId('license-code')] });
}

async function layout(language, phase = 'inactive') {
  await dismissLicense();
  await page.evaluate(language => localStorage.setItem('clarune.language', language), language);
  await page.reload();
  await page.locator('.license-trigger').click();
  await page.waitForFunction(() => !/检查|Checking/.test(document.querySelector('[data-testid="license-status"]')?.textContent ?? 'Checking'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(980, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.locator('.license-dialog').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewport: [innerWidth, innerHeight], clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
  });
  assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport[0] + 1 && geometry.top >= -1 && geometry.bottom <= geometry.viewport[1] + 1, language + ' dialog stays in small viewport');
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, language + ' dialog has no horizontal overflow');
  const heading = await page.locator('.license-hero').evaluate(element => ({ available: element.clientWidth, text: element.firstElementChild.getBoundingClientRect().width, height: element.querySelector('h2').getBoundingClientRect().height }));
  assert.ok(heading.text >= heading.available * 0.7 && heading.height <= 72, language + ' title uses full available width');
  for (const id of ['license-machine', 'license-code', 'license-activate']) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    assert.ok(await page.getByTestId(id).evaluate(element => { const b = element.getBoundingClientRect(); return b.top >= -1 && b.bottom <= innerHeight + 1; }), language + ' reachable ' + id);
  }
  await page.locator('.license-dialog .dialog-close').scrollIntoViewIfNeeded();
  await screenshot(`license-${phase}-${language}-980.png`);
  layouts.push({ language, phase, ...geometry, heading });
  check(language + ' license dialog fits 980x680 with reachable controls');
}

try {
  await launch();
  const status = await page.evaluate(() => window.clarune.getLicenseStatus());
  deviceReadAvailable = Boolean(status.machineCode && status.state !== 'device-unavailable');
  check('Actual Windows device identification is available (identifiers are not logged)', deviceReadAvailable);
  check('Isolated fresh install is inactive with the fixed disposable public key', status.state === 'inactive');
  const device = JSON.parse(Buffer.from(status.machineCode.slice('CLARUNE-DEVICE-1.'.length), 'base64url').toString('utf8')).device_component_hashes;
  const unlicensed = await page.evaluate(async array => {
    const bytes = new Uint8Array(array), options = { format: 'png', quality: 100 };
    return {
      ai: await window.clarune.enhanceImage({ id: 'locked-ai', bytes, upscale: { model: 'real-hat-x4', scale: 4, tileSize: 128 } }),
      image: await window.clarune.saveImage({ bytes, options }, 'locked'),
      pdf: await window.clarune.savePdf({ images: [{ name: 'fixture.png', bytes }], pageSize: 'image', quality: 90 }, 'locked'),
      batch: await window.clarune.saveBatch({ id: 'locked-batch', images: [{ id: 'one', name: 'fixture.png', bytes, options }] }),
    };
  }, fixtureBytes);
  check('Actual IPC denies unlicensed AI, image, PDF and batch before work', Object.values(unlicensed).every(result => !result.ok && result.error === 'LICENSE_REQUIRED'));
  check('Unlicensed calls never show native save or folder dialogs', await app.evaluate(() => globalThis.__licenseQa.saveDialogs === 0 && globalThis.__licenseQa.openDialogs === 0));
  await page.getByTestId('license-status').waitFor();
  check('Preload event crosses the isolated world and opens the actual activation dialog', await page.locator('dialog[open] .license-dialog').count() === 1);
  await dismissLicense();
  await page.getByTestId('original-file-input').setInputFiles(fixture);
  await page.waitForFunction(() => document.querySelector('.viewer-original-layer img') && !document.querySelector('[data-testid="enhance-start"]').disabled);
  await page.getByTestId('enhance-start').click();
  await page.getByTestId('license-status').waitFor();
  check('Clicking the real AI start button opens activation instead of starting inference', await page.locator('dialog[open] .license-dialog').count() === 1 && await page.getByTestId('comparison-image').count() === 0);
  const preview = await page.evaluate(async array => {
    const result = await window.clarune.processImage({ bytes: new Uint8Array(array), options: { format: 'png', quality: 100, rotation: 90, upscale: { model: 'real-hat-x4', scale: 4, tileSize: 128 } } });
    return result.ok ? { ok: true, width: result.value.width, height: result.value.height } : result;
  }, fixtureBytes);
  check('Unlicensed real editing preview works and does not upscale', preview.ok && preview.width === 64 && preview.height === 96);
  await layout('zh-CN'); await layout('en-US');

  const now = Date.now();
  const claims = { product_id: 'eveing-clarune', license_id: 'LIC-DISPOSABLE-E2E', not_before: new Date(now - 60000).toISOString(), expires_at: new Date(now + 86400000).toISOString(), sequence: 1, device_match_min: 2, device_component_hashes: device };
  const finite = issue(claims);
  await page.getByTestId('license-code').fill(finite);
  await page.getByTestId('license-activate').click();
  await page.getByTestId('license-status').filter({ hasText: /^Activated$/ }).waitFor();
  check('Actual UI accepts a correctly signed machine-bound finite license', (await page.evaluate(() => window.clarune.getLicenseStatus())).state === 'active');
  const encryptedPath = join(profile, 'activation-state.bin');
  const encrypted = await readFile(encryptedPath);
  check('Windows safeStorage wrote encrypted activation, with no plaintext token or machine code', encrypted.length > 0 && !encrypted.includes(Buffer.from(finite)) && !encrypted.includes(Buffer.from(status.machineCode)) && !encrypted.includes(Buffer.from('LIC-DISPOSABLE-E2E')));
  const storageAvailable = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  check('Actual Electron Windows safeStorage reports encryption available', storageAvailable);
  await dismissLicense();
  const output = join(scratch, 'licensed-real-export.png');
  await app.evaluate((_electron, path) => { globalThis.__licenseQa.savePath = path; }, output);
  const saved = await page.evaluate(array => window.clarune.saveImage({ bytes: new Uint8Array(array), options: { format: 'png', quality: 100, resize: { width: 48, height: 32, fit: 'fill' } } }, 'licensed'), fixtureBytes);
  check('Activated actual IPC publishes a real Sharp-encoded image', saved.ok && saved.value.width === 48 && saved.value.height === 32);
  const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  check('Exported image fully decodes to its requested dimensions', decoded.info.width === 48 && decoded.info.height === 32);
  await cp(output, join(review, 'licensed-real-export.png'));

  const permanent = issue({ ...claims, expires_at: null, sequence: 2 });
  check('Renewal accepts a higher sequence permanent license', (await page.evaluate(token => window.clarune.activateLicense(token), permanent)).expiresAt === null);
  const wrong = issue({ ...claims, sequence: 3, device_component_hashes: { ...device, machine_guid: device.machine_guid === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64) } });
  check('Authentic token for another machine is rejected', (await page.evaluate(token => window.clarune.activateLicense(token), wrong)).state === 'device-mismatch');
  const tamperedEnvelope = JSON.parse(Buffer.from(permanent.slice('CLARUNE-LICENSE-1.'.length), 'base64url').toString());
  tamperedEnvelope.payload = Buffer.from(JSON.stringify({ ...claims, expires_at: null, sequence: 999 })).toString('base64url');
  const tampered = 'CLARUNE-LICENSE-1.' + Buffer.from(JSON.stringify(tamperedEnvelope)).toString('base64url');
  check('Tampered token is rejected', (await page.evaluate(token => window.clarune.activateLicense(token), tampered)).error === 'SIGNATURE_INVALID');
  check('Failed activation attempts preserve the prior valid permanent state', (await page.evaluate(() => window.clarune.getLicenseStatus())).expiresAt === null);
  await close(); await launch();
  const persisted = await page.evaluate(() => window.clarune.getLicenseStatus());
  check('Full Electron restart decrypts and restores the active permanent license', persisted.state === 'active' && persisted.expiresAt === null && persisted.licenseId === claims.license_id);
  check('A pre-renewal token stays rejected after restart', (await page.evaluate(token => window.clarune.activateLicense(token), finite)).error === 'SEQUENCE_ROLLBACK');
  await layout('zh-CN', 'permanent'); await layout('en-US', 'permanent');
  check('Only test public key and branding are present in disposable resources', (await readdir(join(appDirectory, 'resources'))).sort().join(',') === 'branding,license-public-key.pem');
  check('No renderer exceptions', errors.length === 0);
} catch (error) {
  if (page && app) await screenshot('failure.png').catch(() => {});
  throw new Error(sanitize(error?.message || error));
} finally {
  if (app) await close().catch(() => {});
  privateKey = null; publicKey = null;
  await writeFile(join(review, 'results.json'), JSON.stringify({ date: new Date().toISOString(), passed: checks.length, checks, layouts, errors, deviceReadAvailable, scratch, notes: ['Disposable copied application; isolated userData; only ephemeral test public key persisted.', 'Capability-status handler mocked ready for UI interaction; real activation, DPAPI, gate and export handlers unchanged.', 'No private key, machine code, hardware identifiers or activation tokens are written to this report.'] }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, layouts: layouts.length, errors, deviceReadAvailable, review }));
}
