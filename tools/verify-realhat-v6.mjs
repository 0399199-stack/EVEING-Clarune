import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const project = resolve(import.meta.dirname, '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-realhat-v6-'));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-realhat-v6');
await mkdir(review, { recursive: true });
const source = join(scratch, 'transparent.png'), portrait = join(scratch, 'portrait.png'), large = join(scratch, 'cancel.png');
const raw = Buffer.alloc(96 * 64 * 4);
for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
  const i = (y * 96 + x) * 4;
  raw[i] = x * 255 / 95; raw[i + 1] = y * 255 / 63; raw[i + 2] = (x % 8) < 4 ? 225 : 30;
  raw[i + 3] = x < 8 || y < 8 ? 0 : x < 48 ? 128 : 255;
}
await sharp(raw, { raw: { width: 96, height: 64, channels: 4 } }).png().toFile(source);
await sharp(source).rotate(90).png().toFile(portrait);
await sharp(source).resize(768, 512).png().toFile(large);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(await readFile(source));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.CLARUNE_PREVIEW_EXE || require('electron');
const checks = [], errors = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
let app, page;
const count = () => app.evaluate(() => globalThis.__hatCalls);
const nav = name => page.getByTestId('nav-' + name).click();
const number = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press('Enter'); };
async function launch() {
  app = await _electron.launch({ executablePath, args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
  page = await app.firstWindow(); page.setDefaultTimeout(120000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.webContents.setBackgroundThrottling(false);
    const child = process.getBuiltinModule('child_process'), spawn = child.spawn;
    globalThis.__hatCalls = 0; globalThis.__hatAlive = new Set(); globalThis.__hatTemps = [];
    child.spawn = function (command, args, ...rest) {
      const worker = spawn.call(this, command, args, ...rest);
      if (args?.some(a => String(a).endsWith('realhat-worker.py')) && args.includes('--input')) {
        globalThis.__hatCalls++; globalThis.__hatAlive.add(worker.pid);
        globalThis.__hatTemps.push(args[args.indexOf('--input') + 1]);
        worker.once('close', () => globalThis.__hatAlive.delete(worker.pid));
      }
      return worker;
    };
  });
  await page.getByTestId('enhance-model').waitFor();
  await page.evaluate(() => { globalThis.__hatProgress = []; window.clarune.onEnhancementProgress(p => globalThis.__hatProgress.push(p)); });
}
async function importImage(path) {
  await page.getByTestId('original-file-input').setInputFiles(path);
  await page.locator('.viewer-original-layer img').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="original-file-input"]').disabled);
}
async function readyMain() { await page.waitForFunction(() => !document.querySelector('[data-testid="enhance-start"]').disabled); }
async function runMain() {
  await readyMain(); await page.getByTestId('enhance-start').click();
  await page.getByTestId('enhance-progress').waitFor();
  await page.getByTestId('enhance-progress').waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId('enhance-error').count(), 0);
  await page.getByTestId('comparison-image').waitFor();
}
async function waitWorker() {
  await app.evaluate(() => new Promise((resolveWait, reject) => {
    const end = Date.now() + 30000;
    const timer = setInterval(() => {
      if (globalThis.__hatAlive.size) { clearInterval(timer); resolveWait(); }
      else if (Date.now() > end) { clearInterval(timer); reject(Error('Real-HAT worker did not start')); }
    }, 20);
  }));
}
async function cleanupCheck() {
  check('Real-HAT process exits before owned temporary files are cleaned', await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
    return !globalThis.__hatAlive.size && globalThis.__hatTemps.every(p => !fs.existsSync(path.dirname(p)));
  }));
}
async function close() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
  await closed; app = null;
}
try {
  await launch();
  check('Previous default remains selected; all three models available', await page.getByTestId('enhance-model').inputValue() === 'realesrgan-x4plus' && await page.getByTestId('enhance-model').locator('option').count() === 3);
  const statuses = await page.evaluate(async () => ({ old: await window.clarune.getUpscaleStatus(), hat: await window.clarune.getUpscaleStatus('real-hat-x4'), invalid: await window.clarune.getUpscaleStatus('../../other') }));
  check('Independent existing and Real-HAT runtimes both verified', statuses.old.ok && statuses.old.value.ready && statuses.hat.ok && statuses.hat.value.ready);
  check('IPC rejects arbitrary model identifiers', !statuses.invalid.ok && statuses.invalid.error === 'INVALID_OPTIONS');
  await importImage(source); await page.getByTestId('enhance-model').selectOption('real-hat-x4'); await number('enhancement-scale-number', 2);
  await readyMain(); check('Model selection, import and parameters do not run inference', await count() === 0);
  for (const scale of [2, 3, 4]) {
    await number('enhancement-scale-number', scale); await runMain();
    check(`Real-HAT ${scale}x returns exact dimensions`, (await page.getByTestId('comparison-image').evaluate(img => [img.naturalWidth, img.naturalHeight])).join('x') === `${96*scale}x${64*scale}`);
  }
  check('Exactly one Real-HAT inference per explicit start', await count() === 3);
  const progress = await page.evaluate(() => globalThis.__hatProgress);
  check('Actual tile progress and finishing reach the renderer', progress.some(p => p.stage === 'inference' && p.percent > 0) && progress.some(p => p.stage === 'finishing'));
  const output = join(review, 'realhat-transparent-4x.png');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await page.getByTestId('compression-export').click(); await page.getByTestId('compression-saved').filter({ hasText: output }).waitFor();
  const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => decoded.data[(y * decoded.info.width + x) * 4 + 3];
  check('Transparent, translucent and opaque pixels survive Real-HAT', alpha(0, 0) === 0 && alpha(96, 128) >= 125 && alpha(96, 128) <= 131 && alpha(288, 128) === 255);
  const ordinary = await sharp(source).resize(384, 256).ensureAlpha().raw().toBuffer();
  check('Output is real inference rather than ordinary interpolation', hash(decoded.data) !== hash(ordinary));
  check('Saving completed AI does not rerun the model', await count() === 3);
  await cleanupCheck();
  await page.screenshot({ path: join(review, 'main-realhat-zh.png') });
  await nav('batch'); await page.getByTestId('tool-file-input').setInputFiles([source, portrait]);
  await page.getByTestId('tool-preview-image').waitFor();
  await page.getByTestId('tool-upscale-model').selectOption('real-hat-x4'); await number('tool-upscale-scale-input', 2);
  await page.waitForFunction(() => !document.querySelector('[data-testid="tool-batch-export"]').disabled && !document.querySelector('.tool-processing-indicator.is-busy'));
  check('Batch Real-HAT configuration does not start inference', await count() === 3);
  const batchFolder = join(review, 'batch-realhat-2x'); await mkdir(batchFolder, { recursive: true });
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, batchFolder);
  await page.getByTestId('tool-batch-export').click(); await page.getByTestId('batch-summary').filter({ hasText: batchFolder }).waitFor();
  check('Batch runs Real-HAT once per queued image', await count() === 5);
  const files = await readdir(batchFolder);
  check('Batch publishes exactly two complete images', files.length === 2 && files.every(name => name.endsWith('.png')));
  const sizes = [];
  for (const file of files) { const item = await sharp(join(batchFolder, file)).raw().toBuffer({ resolveWithObject: true }); sizes.push(`${item.info.width}x${item.info.height}`); }
  check('Batch preserves portrait and landscape dimensions', sizes.includes('192x128') && sizes.includes('128x192'));
  await page.screenshot({ path: join(review, 'batch-realhat-zh.png') });
  await nav('settings'); await page.getByRole('button', { name: 'English', exact: true }).click(); await nav('batch');
  check('Natural detail option is translated in English', (await page.getByTestId('tool-upscale-model').locator('option:checked').innerText()).includes('Natural'));
  await nav('settings'); await page.getByRole('button', { name: '简体中文', exact: true }).click(); await nav('enhance');
  if (process.env.CLARUNE_REALHAT_FIXTURE) {
    await importImage(process.env.CLARUNE_REALHAT_FIXTURE); await number('enhancement-scale-number', 4);
    if (!await page.locator('.ai-runtime-settings').evaluate(element => element.open)) await page.locator('.ai-runtime-settings summary').click();
    await page.getByTestId('enhance-tile').selectOption('256');
    await runMain();
    const poster = join(review, 'realhat-poster-from-app.png');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, poster);
    await page.getByTestId('compression-export').click(); await page.getByTestId('compression-saved').filter({ hasText: poster }).waitFor();
    const meta = await sharp(poster).metadata(); await sharp(poster).raw().toBuffer();
    check('User poster completes in the real application at 4344x5792', meta.width === 4344 && meta.height === 5792);
    await page.screenshot({ path: join(review, 'realhat-poster-in-app.png') });
  }
  const beforeCancel = await page.getByTestId('comparison-image').getAttribute('src');
  await readyMain(); await page.getByTestId('enhance-start').click(); await waitWorker();
  await nav('settings'); await page.getByTestId('global-enhance-cancel').click(); await nav('enhance');
  await page.getByTestId('enhance-progress').waitFor({ state: 'hidden' });
  check('Cancel from another page retains previous AI result', await page.getByTestId('comparison-image').getAttribute('src') === beforeCancel);
  await cleanupCheck();
  await importImage(large); await readyMain(); await page.getByTestId('enhance-start').click(); await waitWorker();
  const temporaryInputs = await app.evaluate(() => globalThis.__hatTemps);
  await close();
  check('Close during Real-HAT cleans every owned input after process exit', (await Promise.all(temporaryInputs.map(async path => { try { await readFile(path); return false; } catch { return true; } }))).every(Boolean));
  await launch(); await nav('batch'); await page.getByTestId('tool-preview-image').waitFor();
  check('Batch recipe restores Real-HAT selection', await page.getByTestId('tool-upscale-model').inputValue() === 'real-hat-x4');
  check('Restart never starts inference automatically', await count() === 0 && await page.getByTestId('global-task-bar').count() === 0);
  check('Source bytes unchanged', hash(await readFile(source)) === originalHash);
  check('No renderer exceptions', errors.length === 0);
} catch (error) { if (page && app) await page.screenshot({ path: join(review, 'failure.png') }).catch(() => {}); throw error; }
finally {
  if (app) await close().catch(() => {});
  await writeFile(join(review, 'results.json'), JSON.stringify({ date: new Date().toISOString(), checks, errors, scratch, executablePath }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, scratch }));
}
