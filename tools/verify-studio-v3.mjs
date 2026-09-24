import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-studio-v3-'));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-studio-v3');
await mkdir(review, { recursive: true });
const files = [join(scratch, 'landscape.png'), join(scratch, 'portrait.png')];
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#257aba' } }).png().toFile(files[0]);
await sharp({ create: { width: 300, height: 700, channels: 3, background: '#ad327d' } }).png().toFile(files[1]);
const corrupt = join(scratch, 'broken.png'); await writeFile(corrupt, 'not an image');
const animated = join(scratch, 'animated.webp');
await sharp(Buffer.concat([Buffer.alloc(32 * 32 * 4, 220), Buffer.alloc(32 * 32 * 4, 100)]), { raw: { width: 32, height: 64, channels: 4, pageHeight: 32 } }).webp({ loop: 0, delay: [100, 100] }).toFile(animated);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const checks = [], errors = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require('electron'), args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
  page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 1000); w.webContents.setBackgroundThrottling(false); });
  await page.getByTestId('nav-batch').waitFor();
}
const nav = tool => page.getByTestId('nav-' + tool).click();
async function ready() { await page.waitForFunction(() => !document.querySelector('.tool-processing-indicator.is-busy') && document.querySelector('[data-testid="tool-preview-image"]')); }
const field = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press('Tab'); };
async function folder(name) { const path = join(scratch, name); await mkdir(path); await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path); return path; }
async function batch(name) { const path = await folder(name); await page.getByTestId('tool-batch-export').click(); await page.getByTestId('batch-summary').filter({ hasText: path }).waitFor(); return path; }
async function recoveryValue() { return page.evaluate(() => JSON.parse(localStorage.getItem('clarune.studio-recovery.v2') || 'null')); }
async function persistUntil(predicate) { for (let i = 0; i < 80; i++) { const value = await recoveryValue(); if (predicate(value)) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Recovery not persisted'); }
try {
  await launch(); await nav('resize'); await nav('batch');
  await page.getByTestId('tool-file-input').setInputFiles([...files, corrupt]); await ready();
  check('Tolerant import keeps two valid files', await page.getByTestId('batch-item').count() === 2);
  check('Invalid filename and cause listed', (await page.getByTestId('import-issues').textContent()).includes('broken.png'));
  await nav('crop');
  for (const [preset, ratio] of [['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]]) {
    await page.getByTestId('tool-crop-preset').selectOption(preset); await ready();
    const directory = await batch('ratio-' + preset.replace(':', '-'));
    const outputs = await Promise.all((await readdir(directory)).map(name => sharp(join(directory, name)).metadata()));
    check('F02 fixed ratio ' + preset + ' across mixed aspects', outputs.length === 2 && outputs.every(m => Math.abs(m.width - m.height * ratio) <= ratio));
  }
  await page.getByTestId('tool-reset').click(); await nav('rotate'); await ready();
  for (const [input, normalized] of [['37.45', '37.5'], ['999', '180'], ['-999', '-180'], ['', '-180']]) {
    const target = join(scratch, 'numeric-' + (input || 'empty') + '.png');
    await app.evaluate(({ dialog }, p) => { globalThis.__saves = 0; dialog.showSaveDialog = async () => { globalThis.__saves++; return { canceled: false, filePath: p }; }; }, target);
    await page.getByTestId('tool-rotation-input').fill(input); await ready();
    await page.getByTestId('tool-export').click();
    await page.getByTestId('tool-save-status').filter({ hasText: target }).waitFor();
    check('F03 one physical click exports input ' + (input || 'empty'), await app.evaluate(() => globalThis.__saves) === 1);
    check('Numeric normalized ' + (input || 'empty'), await page.getByTestId('tool-rotation-input').inputValue() === normalized);
    await sharp(target).raw().toBuffer();
  }
  await page.getByTestId('tool-reset').click(); await nav('flip');
  await page.getByTestId('tool-flip-horizontal').click(); await ready();
  await page.getByTestId('tool-undo').click();
  check('Undo removes flip', await page.getByTestId('tool-flip-horizontal').getAttribute('aria-pressed') === 'false');
  await page.getByTestId('tool-redo').click();
  check('Redo restores flip', await page.getByTestId('tool-flip-horizontal').getAttribute('aria-pressed') === 'true');
  await page.getByTestId('tool-applied-edits').locator('summary').click();
  await page.getByTestId('edit-enabled-flipHorizontal').uncheck(); await ready();
  check('Applied recipe can disable individual flip', !await page.getByTestId('edit-enabled-flipHorizontal').isChecked());
  await page.getByTestId('tool-reset').click(); await nav('round'); await field('tool-radius-input', 300); await ready();
  await nav('resize'); await field('tool-width', 100); await ready(); await nav('round'); await ready();
  check('F09 radius field shows effective 37.5 pixels', await page.getByTestId('tool-radius-input').inputValue() === '37.5');
  check('Radius slider bound matches displayed effective value', await page.getByTestId('tool-radius').getAttribute('max') === '37.5');
  await page.getByTestId('tool-reset').click(); await page.getByTestId('tool-add-file-input').setInputFiles(animated); await page.getByTestId('batch-select-2').click();
  await page.getByTestId('tool-error').waitFor();
  check('F04 bad current preview does not disable batch', !await page.getByTestId('tool-batch-export').isDisabled());
  const partial = await batch('partial');
  check('Mixed batch continues with two saved and one failed', (await readdir(partial)).length === 2 && (await page.getByTestId('batch-summary').innerText()).includes('部分导出成功'));
  const retry = await folder('retry'); await page.getByTestId('batch-retry-failed').click(); await page.getByTestId('batch-summary').filter({ hasText: retry }).waitFor();
  check('Retry runs only failed item, all-failed title truthful', (await readdir(retry)).length === 0 && (await page.getByTestId('batch-summary').innerText()).includes('全部导出失败') && (await page.getByTestId('batch-summary').innerText()).includes('失败 1'));
  await page.getByTestId('batch-remove-2').click(); await page.getByTestId('batch-select-0').click(); await nav('watermark');
  await page.getByTestId('tool-watermark-text').fill('CLARUNE 澄像'); await ready();
  await page.getByTestId('tool-font-search').fill('Arial');
  const fonts = await page.getByTestId('tool-watermark-font-family').locator('option').allTextContents();
  check('Font search filters installed fonts', fonts.length > 1 && fonts.slice(1).every(x => /arial/i.test(x)));
  await page.getByTestId('tool-watermark-font-family').selectOption({ index: 1 }); await ready();
  check('Selected font has live sample', (await page.getByTestId('tool-font-preview').innerText()).includes('CLARUNE'));
  await page.getByTestId('tool-watermark-position').selectOption('custom'); await field('tool-watermark-x', 25); await field('tool-watermark-y', 75); await ready();
  await page.getByTestId('tool-watermark-unit').selectOption('pixels');
  check('XY pixel mode shows actual travel coordinate', Number(await page.getByTestId('tool-watermark-x').inputValue()) > 25);
  await nav('pdf'); await page.getByTestId('pdf-file-input').setInputFiles([...files, corrupt]); await page.getByTestId('pdf-item').first().waitFor();
  check('PDF import also retains valid subset', await page.getByTestId('pdf-item').count() === 2);
  await page.getByTestId('pdf-page-size').selectOption('a4-landscape'); await field('pdf-quality-input', 77.7);
  await persistUntil(s => s?.images.length === 2 && s.pdfImages.length === 2 && s.pdfQuality === 77.7 && s.options.watermark?.text === 'CLARUNE 澄像');
  await app.close(); app = null; await launch(); await nav('watermark'); await ready();
  check('Restart restores image queue', await page.getByTestId('batch-item').count() === 2);
  check('Restart restores watermark recipe', await page.getByTestId('tool-watermark-text').inputValue() === 'CLARUNE 澄像');
  check('Restart shows recovery notice', await page.getByTestId('recovery-notice').isVisible());
  check('Restart never resumes export automatically', !await page.getByTestId('tool-batch-export').isDisabled());
  await nav('pdf'); check('Restart restores PDF queue and page settings', await page.getByTestId('pdf-item').count() === 2 && await page.getByTestId('pdf-page-size').inputValue() === 'a4-landscape');
  check('Restart restores PDF numeric quality', await page.getByTestId('pdf-quality-input').inputValue() === '77.7');
  await page.getByTestId('pdf-clear').click(); await nav('resize'); await page.getByTestId('batch-clear').click();
  await persistUntil(s => s === null); check('Clearing both lists deletes recovery cache');
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('clarune.output-history.v1') || '[]'));
  check('Output history contains actual successful files only', history.length === 12 && history.every(x => x.path && x.createdAt));
  const cachedCount = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('clarune-local-recovery', 2); r.onsuccess = () => { const db = r.result, tx = db.transaction('images'), q = tx.objectStore('images').count(); tx.oncomplete = () => { db.close(); resolve(q.result); }; }; }));
  check('Clearing lists physically removes cached image blobs', cachedCount === 0);
  await page.getByTestId('tool-file-input').setInputFiles(files[0]);
  await page.getByTestId('batch-item').waitFor();
  await app.close(); app = null; await launch(); await nav('rotate');
  check('Immediate close after visible import preserves queue', await page.getByTestId('batch-item').count() === 1);
  await page.getByTestId('tool-rotation-input').fill('51.34');
  await app.close(); app = null; await launch(); await nav('rotate');
  check('Immediate close while input focused preserves normalized edit', await page.getByTestId('tool-rotation-input').inputValue() === '51.3');
  const large = join(scratch, 'large-noise.png');
  await sharp(randomBytes(1800 * 1200 * 3), { raw: { width: 1800, height: 1200, channels: 3 } }).png().toFile(large);
  await page.getByTestId('tool-file-input').setInputFiles(Array.from({ length: 8 }, () => large)); await ready();
  await folder('global-cancel'); await page.getByTestId('tool-batch-export').click(); await page.getByTestId('global-task-bar').waitFor();
  await nav('settings'); check('F05 global task and cancel stay visible on Settings', await page.getByTestId('global-task-stop').isVisible());
  await nav('pdf'); check('F05 global task and cancel stay visible on PDF', await page.getByTestId('global-task-stop').isVisible());
  await page.getByTestId('global-task-stop').click(); await nav('resize');
  await page.getByTestId('batch-summary').filter({ hasText: '已停止' }).waitFor();
  check('Global stop reaches batch and returns truthful canceled state');
  const closeDirectory = await folder('interrupted-close'); await page.getByTestId('tool-batch-export').click(); await page.getByTestId('global-task-bar').waitFor();
  const closed = app.waitForEvent('close'); await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); }); await closed; app = null;
  for (const name of await readdir(closeDirectory)) await sharp(join(closeDirectory, name)).raw().toBuffer();
  await launch(); await nav('resize');
  check('Normal close during batch recovers all queue items', await page.getByTestId('batch-item').count() === 8);
  check('Interrupted recovery is explicitly explained', (await page.getByTestId('recovery-notice').innerText()).includes('中断'));
  check('Interrupted task does not restart itself', !await page.getByTestId('global-task-bar').count());
  await page.screenshot({ path: join(review, 'studio-recovered.png') });
  check('No renderer errors', errors.length === 0);
} finally {
  if (app) await app.close();
  await writeFile(join(review, 'results.json'), JSON.stringify({ checks, errors, scratch }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors, scratch }, null, 2));
}
