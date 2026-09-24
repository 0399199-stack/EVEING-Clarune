import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const runtime = process.env.CLARUNE_REAL_AI_RUNTIME;
assert.ok(runtime, 'Set CLARUNE_REAL_AI_RUNTIME to an existing verified external runtime');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-upscale-v4-'));
await mkdir(join(scratch, 'profile'));
await writeFile(join(scratch, 'profile', 'upscale-runtime.json'), JSON.stringify({ directory: join(scratch, 'missing-runtime'), localOnly: true }));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-upscale-v4');
await mkdir(review, { recursive: true });
const source = join(scratch, 'source.png'), portrait = join(scratch, 'portrait.png');
await sharp(Buffer.from('<svg width="96" height="64"><rect width="96" height="64" fill="#137caf"/><circle cx="40" cy="30" r="21" fill="#ffc837"/><path d="M0 60L90 0" stroke="white" stroke-width="3"/></svg>')).png().toFile(source);
await sharp(source).rotate(90).png().toFile(portrait);
const originalHash = createHash('sha256').update(await readFile(source)).digest('hex');
const oversized = join(scratch, 'oversized.png');
await sharp({ create: { width: 1601, height: 1601, channels: 3, background: '#236fb2' } }).png().toFile(oversized);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const checks = [], errors = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require('electron'), args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
  page = await app.firstWindow(); page.setDefaultTimeout(60000); page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 1000); window.webContents.setBackgroundThrottling(false);
    const child = process.getBuiltinModule('child_process'), spawn = child.spawn;
    globalThis.__aiCalls = 0;
    child.spawn = function (command, ...args) { if (String(command).endsWith('realesrgan-ncnn-vulkan.exe')) globalThis.__aiCalls++; return spawn.call(this, command, ...args); };
  });
  await page.getByTestId('nav-settings').waitFor();
}
const nav = name => page.getByTestId('nav-' + name).click();
const countAI = () => app.evaluate(() => globalThis.__aiCalls);
const ready = () => page.waitForFunction(() => !document.querySelector('.tool-processing-indicator.is-busy') && document.querySelector('[data-testid="tool-preview-image"]'));
const input = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press('Tab'); };
async function directory(name) { const folder = join(scratch, name); await mkdir(folder); await picker(folder); return folder; }
async function picker(folder) { await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, folder); }
async function completed(folder) { await page.getByTestId('batch-summary').filter({ hasText: folder }).waitFor(); }
async function close() { const closed = app.waitForEvent('close'); await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); }); await closed; app = null; }
try {
  await launch();
  await page.getByTestId('open-batch-upscale').click();
  check('Main workspace has a working entry to AI batch', await page.getByTestId('nav-batch').getAttribute('aria-current') === 'page');
  check('AI upscale is first batch tool', await page.locator('.tool-batch-tools button').first().getAttribute('data-testid') === 'batch-tool-upscale');
  check('AI upscale is selected by default', await page.getByTestId('batch-tool-upscale').getAttribute('aria-pressed') === 'true');
  await page.getByTestId('tool-file-input').setInputFiles([source, portrait]); await ready();
  check('Missing runtime blocks AI export with setup entry', await page.getByTestId('tool-batch-export').isDisabled() && await page.getByTestId('tool-upscale-runtime-select').isVisible());
  await picker(runtime); await page.getByTestId('tool-upscale-runtime-select').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="tool-batch-export"]').disabled);
  check('Native chooser registers verified external runtime', (await page.evaluate(() => window.clarune.getUpscaleStatus())).value.ready);
  await input('tool-upscale-scale-input', 2); await ready();
  check('Scale supports direct input', await page.getByTestId('tool-upscale-scale').inputValue() === '2');
  await input('tool-upscale-scale-input', 99); await ready();
  check('Out-of-range scale is normalized', await page.getByTestId('tool-upscale-scale-input').inputValue() === '4');
  await input('tool-upscale-scale-input', 2); await ready();
  check('Parameter changes never start GPU inference', await countAI() === 0);
  check('Preview explicitly excludes AI results', (await page.getByTestId('tool-preview-note').innerText()).includes('AI'));
  const folder = await directory('batch-2x'); await copyFile(source, join(folder, 'source.png'));
  await page.getByTestId('tool-batch-export').click(); await completed(folder);
  check('Batch executes real AI once per image', await countAI() === 2);
  const names = await readdir(folder);
  check('Same-name output does not overwrite existing file', names.includes('source (1).png') && createHash('sha256').update(await readFile(join(folder, 'source.png'))).digest('hex') === originalHash);
  const landscapeMeta = await sharp(join(folder, 'source (1).png')).metadata();
  const portraitMeta = await sharp(join(folder, 'portrait.png')).metadata();
  check('Batch respects both landscape and portrait dimensions', landscapeMeta.width === 192 && landscapeMeta.height === 128 && portraitMeta.width === 128 && portraitMeta.height === 192);
  for (const name of names) await sharp(join(folder, name)).raw().toBuffer();
  check('All saved images fully decode');
  await page.screenshot({ path: join(review, 'batch-upscale-zh.png') });
  await page.getByTestId('batch-tool-compress').click(); await ready();
  check('Switching tools retains the enabled AI recipe', (await page.getByTestId('tool-batch-export').innerText()).includes('超清'));
  await page.getByTestId('tool-applied-edits').locator('summary').click(); await page.getByTestId('edit-enabled-upscale').uncheck(); await ready();
  const localFolder = await directory('ordinary-export'); await page.getByTestId('tool-batch-export').click(); await completed(localFolder);
  check('Disabling AI preserves ordinary batch export without GPU', await countAI() === 2 && (await sharp(join(localFolder, 'source.png')).metadata()).width === 96);
  await page.getByTestId('batch-tool-upscale').click(); await page.getByTestId('tool-upscale-enabled').check();
  await input('tool-upscale-scale-input', 4); await page.getByTestId('tool-upscale-model').selectOption('realesrgan-x4plus-anime');
  await page.getByTestId('tool-format-webp').click(); await input('tool-quality-input', 82.5); await ready();
  const single = join(scratch, 'anime-4x.webp');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, single);
  await page.getByTestId('tool-export').click(); await page.getByTestId('tool-save-status').filter({ hasText: single }).waitFor();
  const singleMeta = await sharp(single).metadata(); await sharp(single).raw().toBuffer();
  check('Anime AI and output compression execute together', await countAI() === 3 && singleMeta.format === 'webp' && singleMeta.width === 384 && singleMeta.height === 256);
  await page.getByTestId('tool-file-input').setInputFiles(oversized); await ready();
  check('Oversized AI input has a visible limit and single export is blocked', await page.getByTestId('tool-export').isDisabled() && await page.getByTestId('tool-upscale-limit').isVisible());
  const bigFolder = await directory('oversized-rejected'); await page.getByTestId('tool-batch-export').click(); await completed(bigFolder);
  check('Oversized batch fails before GPU or output creation', await countAI() === 3 && (await readdir(bigFolder)).length === 0);
  await page.getByTestId('tool-file-input').setInputFiles([source, portrait, source, portrait]); await ready();
  const canceledFolder = await directory('canceled'); await page.getByTestId('tool-batch-export').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="global-task-bar"]'));
  await nav('settings'); await page.getByTestId('global-task-stop').click(); await nav('batch'); await completed(canceledFolder);
  const canceledFiles = await readdir(canceledFolder);
  check('Global stop prevents remaining AI images', canceledFiles.length < 4 && (await page.getByTestId('batch-summary').innerText()).includes('已停止'));
  for (const name of canceledFiles) await sharp(join(canceledFolder, name)).raw().toBuffer();
  check('Cancel leaves only complete, decodable outputs', canceledFiles.every(name => !name.includes('partial')));
  await nav('settings'); await page.getByRole('button', { name: 'English', exact: true }).click(); await nav('batch');
  check('AI controls are localized in English', (await page.getByTestId('batch-tool-upscale').innerText()).includes('AI Upscale') && (await page.getByTestId('tool-batch-export').innerText()).includes('AI'));
  await page.screenshot({ path: join(review, 'batch-upscale-en.png') });
  await close(); await launch(); await nav('batch'); await ready();
  check('Runtime and queue survive restart', (await page.evaluate(() => window.clarune.getUpscaleStatus())).value.ready && await page.getByTestId('batch-item').count() === 4);
  check('Recovery never resumes AI automatically', await countAI() === 0 && !await page.getByTestId('global-task-bar').count());
  const closingFolder = await directory('safe-close-during-ai');
  await page.getByTestId('tool-batch-export').click();
  await app.evaluate(() => new Promise(resolve => {
    const timer = setInterval(() => { if (globalThis.__aiCalls > 0) { clearInterval(timer); resolve(); } }, 20);
  }));
  await close();
  const closingFiles = await readdir(closingFolder);
  check('Closing during inference waits for one complete image and stops the rest', closingFiles.length === 1 && !closingFiles[0].includes('partial'));
  await sharp(join(closingFolder, closingFiles[0])).raw().toBuffer();
  check('Output completed during safe close fully decodes');
  check('Original source remains unchanged', createHash('sha256').update(await readFile(source)).digest('hex') === originalHash);
  check('No renderer exceptions', errors.length === 0);
} finally {
  if (page && app) await page.screenshot({ path: join(review, 'last-state.png') }).catch(() => {});
  if (app) await close().catch(() => app?.close());
  await writeFile(join(review, 'results.json'), JSON.stringify({ checks, errors, scratch, runtime, executable: process.env.CLARUNE_PREVIEW_EXE || 'development' }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors, scratch }));
}
