import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-enhance-v5-'));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-enhance-v5');
await mkdir(review, { recursive: true });
const source = join(scratch, 'original.png'), large = join(scratch, 'cancel.png'), oversized = join(scratch, 'oversized.png');
await sharp(Buffer.from('<svg width="96" height="64"><rect width="90" height="64" fill="#117db6"/><circle cx="44" cy="28" r="20" fill="#ffcb42"/><path d="M4 58L87 7" stroke="white" stroke-width="3"/></svg>')).png().toFile(source);
await sharp(source).resize(768, 512).png().toFile(large);
await sharp({ create: { width: 1601, height: 1601, channels: 3, background: '#3184bb' } }).png().toFile(oversized);
const hash = data => createHash('sha256').update(data).digest('hex');
const originalHash = hash(await readFile(source));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.CLARUNE_PREVIEW_EXE || require('electron');
let app, page;
const checks = [], errors = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const count = () => app.evaluate(() => globalThis.__aiCalls);
const alive = () => app.evaluate(() => globalThis.__aiAlive.size);
const setNumber = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press('Enter'); };
const nav = name => page.getByTestId('nav-' + name).click();
async function launch() {
  app = await _electron.launch({ executablePath: exe, args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
  page = await app.firstWindow(); page.setDefaultTimeout(60000); page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.webContents.setBackgroundThrottling(false);
    const child = process.getBuiltinModule('child_process'), spawn = child.spawn;
    globalThis.__aiCalls = 0; globalThis.__aiAlive = new Set(); globalThis.__aiTemps = [];
    child.spawn = function (command, args, ...rest) {
      const worker = spawn.call(this, command, args, ...rest);
      if (String(command).endsWith('realesrgan-ncnn-vulkan.exe')) {
        globalThis.__aiCalls++; globalThis.__aiAlive.add(worker.pid); globalThis.__aiTemps.push(args[args.indexOf('-i') + 1]);
        worker.once('close', () => globalThis.__aiAlive.delete(worker.pid));
      }
      return worker;
    };
  });
  await page.getByTestId('enhance-start').waitFor();
  await page.evaluate(() => { globalThis.__progress = []; window.clarune.onEnhancementProgress(p => globalThis.__progress.push(p)); });
}
async function importSource(path) {
  await page.getByTestId('original-file-input').setInputFiles(path);
  await page.locator('.viewer-original-layer img').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="original-file-input"]').disabled);
}
async function done() {
  await page.getByTestId('enhance-progress').waitFor({ state: 'hidden' });
  await page.getByTestId('ai-result-dimensions').waitFor();
  assert.equal(await page.getByTestId('enhance-error').count(), 0);
}
async function waitNative() {
  await app.evaluate(() => new Promise((resolve, reject) => {
    const end = Date.now() + 30000;
    const timer = setInterval(() => {
      if (globalThis.__aiAlive.size) { clearInterval(timer); resolve(); }
      else if (Date.now() > end) { clearInterval(timer); reject(new Error('No AI process started')); }
    }, 20);
  }));
}
async function assertCleanup() {
  check('Owned workers exited and temporary input folders removed', await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
    return !globalThis.__aiAlive.size && globalThis.__aiTemps.every(p => !fs.existsSync(path.dirname(p)));
  }));
}
async function close() {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); });
  await closed; app = null;
}
try {
  await launch();
  const status = await page.evaluate(() => window.clarune.getUpscaleStatus());
  check('Verified workstation runtime is detected without download or setup', status.ok && status.value.ready && status.value.source === 'detected');
  check('Start is disabled without an input', await page.getByTestId('enhance-start').isDisabled());
  await importSource(source); await setNumber('enhancement-scale-number', 2);
  check('Import and parameter changes never run AI', await count() === 0);
  await page.getByTestId('enhance-start').click(); await page.getByTestId('enhance-progress').waitFor();
  check('Source and export are locked while AI runs', await page.getByTestId('original-file-input').isDisabled() && await page.getByTestId('compression-export').isDisabled());
  await done();
  check('One explicit click runs exactly one native inference', await count() === 1);
  const dims = await page.getByTestId('comparison-image').evaluate(img => [img.naturalWidth, img.naturalHeight]);
  check('Real 2x result is loaded at 192x128', dims.join('x') === '192x128');
  check('Completed AI automatically selects sliding comparison and AI export', await page.locator('.comparison-handle').isVisible() && await page.getByTestId('export-source').inputValue() === 'comparison' && (await page.getByTestId('compression-export').innerText()).includes('超清'));
  const resultBase64 = await page.getByTestId('comparison-image').evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
  });
  const decoded = await sharp(Buffer.from(resultBase64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const ordinary = await sharp(source).resize(192, 128).raw().toBuffer();
  check('AI pixels are not ordinary interpolation; transparency survives', hash(decoded.data) !== hash(ordinary) && decoded.info.channels === 4 && decoded.data.some((v, i) => i % 4 === 3 && v === 0));
  const progress = await page.evaluate(() => globalThis.__progress);
  check('Actual engine progress and finishing stages reach renderer', progress.some(p => p.stage === 'inference') && progress.some(p => p.stage === 'finishing') && progress.every(p => p.percent === undefined || (p.percent >= 0 && p.percent <= 100)));
  await setNumber('viewer-split-number', 31);
  check('Comparison divider supports typed position', await page.locator('.comparison-handle').getAttribute('aria-valuenow') === '31');
  const viewport = page.getByTestId('image-viewport'), before = Number(await viewport.getAttribute('data-zoom'));
  await viewport.hover(); await page.mouse.wheel(0, 240);
  await page.waitForFunction(value => Number(document.querySelector('[data-testid="image-viewport"]').dataset.zoom) < value, before);
  check('Mouse wheel zoom works on AI comparison');
  await page.getByRole('button', { name: 'WEBP', exact: true }).click(); await setNumber('output-quality-number', 82.5);
  const output = join(scratch, 'saved-ai.webp');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await page.getByTestId('compression-export').click(); await page.getByTestId('compression-saved').filter({ hasText: output }).waitFor();
  const meta = await sharp(output).metadata(); await sharp(output).raw().toBuffer();
  check('AI result saves and compresses without another inference', await count() === 1 && meta.width === 192 && meta.height === 128 && meta.format === 'webp');
  await page.screenshot({ path: join(review, 'main-ai-complete-zh.png') });
  await setNumber('enhancement-scale-number', 3); await page.getByTestId('enhance-model').selectOption('realesrgan-x4plus-anime');
  const previousResult = await page.getByTestId('comparison-image').getAttribute('src');
  await page.getByTestId('enhance-start').click(); await page.getByTestId('enhance-progress').waitFor();
  await nav('settings');
  check('Active AI task remains visible on another page', await page.getByTestId('global-task-bar').isVisible());
  await nav('enhance'); await done();
  check('Anime 3x replaces result without replacing source', await count() === 2 && (await page.getByTestId('comparison-image').evaluate(img => [img.naturalWidth, img.naturalHeight])).join('x') === '288x192' && await page.getByTestId('comparison-image').getAttribute('src') !== previousResult && await page.locator('.viewer-original-layer img').evaluate(img => img.naturalWidth) === 96);
  await assertCleanup();
  const validResult = await page.getByTestId('comparison-image').getAttribute('src');
  await page.getByTestId('enhance-start').click(); await waitNative();
  await nav('batch');
  check('Other exports and runtime replacement are blocked during main AI', await page.getByTestId('tool-batch-export').isDisabled() && await page.getByTestId('tool-upscale-runtime-select').isDisabled());
  await page.getByTestId('global-enhance-cancel').click(); await nav('enhance');
  await page.getByTestId('enhance-progress').waitFor({ state: 'hidden' });
  check('Cancel retains previous successful result', (await page.getByTestId('enhance-notice').innerText()).includes('取消') && await page.getByTestId('comparison-image').getAttribute('src') === validResult);
  await assertCleanup();
  const callsBeforeLarge = await count(); await importSource(oversized);
  check('Oversized source cannot begin inference', await page.getByTestId('enhance-start').isDisabled() && await count() === callsBeforeLarge);
  await importSource(source); await setNumber('enhancement-scale-number', 4);
  await page.getByTestId('enhance-start').click(); await page.getByTestId('enhance-progress').waitFor(); await done();
  check('After cancel and invalid input, subsequent 4x AI succeeds', (await page.getByTestId('comparison-image').evaluate(img => [img.naturalWidth, img.naturalHeight])).join('x') === '384x256');
  await nav('settings'); await page.getByRole('button', { name: 'English', exact: true }).click(); await nav('enhance');
  check('Main AI workflow is localized', (await page.getByTestId('enhance-start').innerText()).includes('AI') && (await page.getByTestId('ai-result-dimensions').innerText()).includes('AI'));
  await page.screenshot({ path: join(review, 'main-ai-complete-en.png') });
  check('Original file remains byte-for-byte unchanged', hash(await readFile(source)) === originalHash);
  await importSource(large); await page.getByTestId('enhance-start').click(); await waitNative();
  const cleanupPaths = await app.evaluate(() => globalThis.__aiTemps);
  await close();
  check('Closing during inference removes owned temporary files', (await Promise.all(cleanupPaths.map(async path => { try { await readFile(path); return false; } catch { return true; } }))).every(Boolean));
  await launch(); check('Restart never automatically resumes AI', await count() === 0 && !await page.getByTestId('global-task-bar').count());
  check('No renderer exceptions', errors.length === 0);
  check('No partial files published', !(await readdir(scratch)).some(name => name.includes('partial')));
} catch (error) { if (page) await page.screenshot({ path: join(review, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(join(review, 'enhance.json'), JSON.stringify({ date: new Date().toISOString(), exe, scratch, checks, errors }, null, 2)); if (app) await close().catch(() => {}); console.log(JSON.stringify({ passed: checks.length, scratch, errors })); }
