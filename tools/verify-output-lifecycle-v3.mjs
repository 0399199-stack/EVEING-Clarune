import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const review = resolve(process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-safety-v3'));
await mkdir(review, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'clarune-safety-v3-'));
const noise = join(scratch, 'noise.png');
await sharp(randomBytes(4000 * 3000 * 3), { raw: { width: 4000, height: 3000, channels: 3 } }).png({ compressionLevel: 0 }).toFile(noise);
const results = [];
for (const mode of ['single', 'pdf', 'reload']) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require('electron'), args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, mode + '-profile')}`] : [project, `--user-data-dir=${join(scratch, mode + '-profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  // Electron handles beforeunload in main; avoid Playwright auto-accepting a
  // Chromium dialog which Electron has already dismissed without displaying.
  page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => undefined); });
  let closed = false; app.on('close', () => { closed = true; });
  try {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false); });
    await page.getByTestId('nav-resize').click();
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.dataset.testid = 'lifecycle-fixture-input'; input.hidden = true; document.body.append(input); });
    const inputId = 'lifecycle-fixture-input';
    await page.getByTestId(inputId).setInputFiles(noise);
    if (mode !== 'reload') {
      const target = join(scratch, `closed-${mode}.${mode === 'pdf' ? 'pdf' : 'png'}`);
      await app.evaluate(({ dialog, BrowserWindow }, filePath) => {
        dialog.showSaveDialog = async () => { setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 0); return { canceled: false, filePath }; };
      }, target);
      await page.evaluate(async ({ mode, inputId }) => {
        const bytes = new Uint8Array(await document.querySelector(`[data-testid="${inputId}"]`).files[0].arrayBuffer());
        const task = mode === 'pdf' ? window.clarune.savePdf({ images: [{ name: 'noise.png', bytes }], pageSize: 'image', quality: 90 }, 'closed') : window.clarune.saveImage({ bytes, options: { format: 'png', quality: 100 } }, 'closed');
        task.catch(() => undefined);
      }, { mode, inputId });
      for (let n = 0; n < 600 && !closed; n++) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!closed) throw new Error('normal close never completed');
      const size = (await stat(target)).size;
      if (mode === 'single') await sharp(target).raw().toBuffer();
      else { const pdf = await require('pdf-lib').PDFDocument.load(await readFile(target)); if (pdf.getPageCount() !== 1) throw new Error('PDF page count'); }
      const result = { mode, closed, valid: true, size, target }; results.push(result); console.log(JSON.stringify(result));
    } else {
      const dir = join(scratch, 'reload-output'); await mkdir(dir);
      await app.evaluate(({ dialog, BrowserWindow }, directory) => {
        dialog.showOpenDialog = async () => {
          setTimeout(() => BrowserWindow.getAllWindows()[0]?.webContents.reload(), 40);
          return { canceled: false, filePaths: [directory] };
        };
      }, dir);
      await page.evaluate(async (inputId) => {
        const bytes = new Uint8Array(await document.querySelector(`[data-testid="${inputId}"]`).files[0].arrayBuffer());
        window.__lifecycleToken = 'survives-reload';
        window.__lifecycleResult = null;
        window.clarune.saveBatch({ id: 'reload-regression', images: [0, 1].map((id) => ({ id: String(id), name: `noise-${id}.png`, bytes, options: { format: 'png', quality: 100 } })) }).then((value) => { window.__lifecycleResult = value; });
      }, inputId);
      await page.waitForFunction(() => window.__lifecycleResult !== null && window.__lifecycleResult !== undefined, null, { timeout: 90000 });
      const result = await page.evaluate(() => ({ token: window.__lifecycleToken, result: window.__lifecycleResult }));
      if (result.token !== 'survives-reload' || !result.result.ok || result.result.value.items.filter((item) => item.status === 'saved').length !== 2) throw new Error('reload interrupted task: ' + JSON.stringify(result));
      for (const item of result.result.value.items) await sharp(item.file.path).raw().toBuffer();
      const menuRemoved = await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null);
      await page.keyboard.press('F5'); await page.keyboard.press('Control+r');
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (await page.evaluate(() => window.__lifecycleToken) !== 'survives-reload') throw new Error('release shortcut reloaded renderer');
      if (!menuRemoved) throw new Error('release menu present');
      const report = { mode, token: result.token, saved: 2, menuRemoved, shortcutPreserved: true, files: await readdir(dir) }; results.push(report); console.log(JSON.stringify(report));
    }
  } finally { if (!closed) await app.close(); }
}
const reportPath = join(review, 'safety-verification.json');
await writeFile(reportPath, JSON.stringify({ passed: true, at: new Date().toISOString(), packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), scratch, results }, null, 2));
console.log('REPORT=' + reportPath);
