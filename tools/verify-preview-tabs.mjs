import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-preview-tabs-'));
const report = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-preview-tabs');
await mkdir(report, { recursive: true });
const fixture = join(scratch, 'fixture.png');
await sharp({ create: { width: 80, height: 60, channels: 3, background: '#2194c4' } }).png().toFile(fixture);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require('electron'), args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
const page = await app.firstWindow(); page.setDefaultTimeout(15000);
await page.emulateMedia({ reducedMotion: 'reduce' });
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
const checks = [], errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  for (const language of ['zh-CN', 'en-US']) for (const density of ['comfortable', 'compact']) {
    await page.getByTestId('nav-batch').waitFor();
    await page.evaluate(({ language, density }) => { localStorage.setItem('clarune.language', language); localStorage.setItem('clarune.density', density); }, { language, density });
    await page.reload(); await page.getByTestId('nav-batch').click();
    for (const [width, height] of [[980, 680], [1280, 820], [1600, 1000]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
      for (const mode of ['upscale', 'crop']) {
        await page.getByTestId('batch-tool-' + mode).click();
        if (mode === 'crop') {
          await page.getByTestId('batch-tool-upscale').click();
          await page.getByTestId('tool-file-input').setInputFiles(fixture);
          await page.getByTestId('tool-preview-image').waitFor();
          await page.getByTestId('batch-tool-crop').click();
        }
        assert.match(await page.getByTestId('tool-show-preview').textContent(), /AI/);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await page.locator('.tool-canvas-toolbar .tool-segments').evaluate(group => {
          const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
          return { group: box(group), toolbar: box(group.parentElement), buttons: [...group.querySelectorAll('button')].map(button => {
            const range = document.createRange(); range.selectNodeContents(button);
            return { text: button.textContent, box: box(button), textBox: box(range), clientWidth: button.clientWidth, scrollWidth: button.scrollWidth };
          }) };
        });
        const name = `${language}-${density}-${width}-${mode}`;
        checks.push({ name, ...geometry });
        for (const button of geometry.buttons) {
          assert.ok(button.textBox.left >= button.box.left + 5 && button.textBox.right <= button.box.right - 5, `${name}: text escapes button: ${button.text}`);
          assert.ok(button.scrollWidth <= button.clientWidth + 1, `${name}: button overflows`);
          assert.ok(button.box.left >= geometry.group.left && button.box.right <= geometry.group.right, `${name}: button escapes group`);
        }
        assert.ok(geometry.group.right <= geometry.toolbar.right, `${name}: group escapes toolbar`);
        if (density === 'comfortable' && width === 1280 && mode === 'upscale') await page.locator('.tool-canvas-toolbar').screenshot({ path: join(report, language + '.png') });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, errors }));
} catch (error) { await page.screenshot({ path: join(report, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(join(report, 'results.json'), JSON.stringify({ checks, errors }, null, 2)); await app.close(); }
